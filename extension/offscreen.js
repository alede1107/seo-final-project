
//   1. Opens the tab audio stream via getUserMedia + the stream ID.
//   2. Pipes audio back to the speakers (tabCapture MUTES the tab otherwise).
//   3. Records self-contained WebM chunks by restarting MediaRecorder,
//      NOT by using timeslice (timeslice chunks after the first are
//      headerless and unplayable as standalone files).
//   4. POSTs each chunk to the Flask backend.

const BACKEND_URL = "http://localhost:5001/upload";
const CHUNK_MS = 10000; // 10-second chunks

let mediaStream = null;
let recorder = null;
let chunkTimer = null;
let stopping = false;
let chunkIndex = 0;
let sessionId = null;
let videoId = null;

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.target !== "offscreen") return;
  if (msg.type === "OFFSCREEN_START") startCapture(msg).catch((err) => console.error("startCapture failed:", err));
  if (msg.type === "OFFSCREEN_STOP") stopCapture();
});

// Ask the content script (via the service worker) for the video's live
// currentTime. This is the source of truth for alignment — reading it live
// survives pause, seek, and playback-speed changes, which wall-clock math
// cannot. Returns seconds, or 0 if unavailable.
async function sampleVideoTime() {
  try {
    const resp = await chrome.runtime.sendMessage({ type: "SAMPLE_VIDEO_TIME" });
    return resp && typeof resp.videoTime === "number" ? resp.videoTime : 0;
  } catch (_) {
    return 0;
  }
}

async function startCapture({ streamId, videoId: vid, sessionId: sid }) {
  if (mediaStream) return; // already running

  videoId = vid || "unknown";
  sessionId = sid || `${videoId}-${Date.now()}`;
  chunkIndex = 0;
  stopping = false;

  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId,
      },
    },
    video: false,
  });

  // CRITICAL: tabCapture silences the tab for the user. Re-route the
  // audio to the default output so the video still plays sound.
  const audioCtx = new AudioContext();
  const source = audioCtx.createMediaStreamSource(mediaStream);
  source.connect(audioCtx.destination);

  startNewRecorderCycle();
}

function startNewRecorderCycle() {
  if (!mediaStream || stopping) return;

  recorder = new MediaRecorder(mediaStream, {
    mimeType: "audio/webm;codecs=opus",
    audioBitsPerSecond: 64_000,
  });

  const parts = [];
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) parts.push(e.data);
  };

  recorder.onstop = async () => {
    const blob = new Blob(parts, { type: "audio/webm" });
    if (blob.size > 0) {
      // Live video time at this chunk's start and end. Sampling the actual
      // <video>.currentTime (not wall-clock math) keeps captions aligned
      // through pause/seek/speed changes. The 10s chunk guarantees the start
      // sample has resolved by now.
      const startT = await startSample;
      const endT = await sampleVideoTime();
      uploadChunk(blob, chunkIndex++, startT, endT);
    }

    if (stopping) {
      cleanup();
    } else {
      // Immediately begin the next self-contained chunk.
      startNewRecorderCycle();
    }
  };

  recorder.start();
  // Sample the video's live currentTime at the instant this chunk started.
  const startSample = sampleVideoTime();
  chunkTimer = setTimeout(() => {
    if (recorder && recorder.state === "recording") recorder.stop();
  }, CHUNK_MS);
}

async function uploadChunk(blob, index, videoTimeStart, videoTimeEnd) {
  const form = new FormData();
  form.append("audio", blob, `chunk-${index}.webm`);
  form.append("video_id", videoId);
  form.append("session_id", sessionId);
  form.append("chunk_index", String(index));
  form.append("video_time_offset", String(videoTimeStart));
  form.append("video_time_end", String(videoTimeEnd));
  form.append("captured_at", new Date().toISOString());

  try {
    const res = await fetch(BACKEND_URL, { method: "POST", body: form });
    if (!res.ok) {
      console.error(`Upload failed for chunk ${index}: ${res.status}`);
    }
  } catch (err) {
    // Backend down or unreachable. Log and move on; do not kill capture.
    console.error(`Upload error for chunk ${index}:`, err);
  }
}

function stopCapture() {
  stopping = true;
  clearTimeout(chunkTimer);
  if (recorder && recorder.state === "recording") {
    recorder.stop(); // onstop handles the final upload + cleanup
  } else {
    cleanup();
  }
}

function cleanup() {
  if (mediaStream) {
    mediaStream.getTracks().forEach((t) => t.stop());
    mediaStream = null;
  }
  recorder = null;
  chrome.runtime.sendMessage({ type: "OFFSCREEN_DONE" });
}