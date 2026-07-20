// offscreen.js
// Runs in the offscreen document. This is the only extension context that
// can hold the MediaStream. It:
//   1. Opens the tab audio stream via getUserMedia + the stream ID.
//   2. Pipes audio back to the speakers.
//   3. Converts the live stream to 16 kHz mono PCM16 and forwards it to the
//      backend in near-real time.

const BACKEND_URL = "http://localhost:5001";
const STREAM_SAMPLE_RATE = 16000;
const FLUSH_SAMPLES = 4000; // 250ms at 16 kHz

let mediaStream = null;
let audioCtx = null;
let sourceNode = null;
let processorNode = null;
let stopping = false;
let flushing = false;
let sessionId = null;
let videoId = null;
let pcmBuffer = new Float32Array(0);

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.target !== "offscreen") return;
  if (msg.type === "OFFSCREEN_START") startCapture(msg).catch((err) => console.error("startCapture failed:", err));
  if (msg.type === "OFFSCREEN_STOP") stopCapture();
});

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
  stopping = false;

  const startRes = await fetch(`${BACKEND_URL}/stream/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ video_id: videoId, session_id: sessionId }),
  });
  if (!startRes.ok) {
    throw new Error(`stream start failed: ${startRes.status}`);
  }

  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId,
      },
    },
    video: false,
  });

  audioCtx = new AudioContext();
  sourceNode = audioCtx.createMediaStreamSource(mediaStream);
  processorNode = audioCtx.createScriptProcessor(2048, Math.max(1, sourceNode.channelCount || 2), 1);

  processorNode.onaudioprocess = (event) => {
    if (stopping) return;

    const input = event.inputBuffer;
    const output = event.outputBuffer;
    const mono = mixDownToMono(input);

    // Keep audio audible while we tap the stream.
    output.getChannelData(0).set(mono);

    const resampled = downsampleBuffer(mono, audioCtx.sampleRate, STREAM_SAMPLE_RATE);
    appendFloat32(resampled);

    if (!flushing && pcmBuffer.length >= FLUSH_SAMPLES) {
      flushBufferedAudio().catch((err) => console.error("flushBufferedAudio failed:", err));
    }
  };

  sourceNode.connect(processorNode);
  processorNode.connect(audioCtx.destination);
}

function mixDownToMono(inputBuffer) {
  const channels = inputBuffer.numberOfChannels || 1;
  const length = inputBuffer.length;
  if (channels === 1) {
    return inputBuffer.getChannelData(0).slice(0);
  }

  const mono = new Float32Array(length);
  for (let ch = 0; ch < channels; ch++) {
    const data = inputBuffer.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      mono[i] += data[i] / channels;
    }
  }
  return mono;
}

function downsampleBuffer(buffer, inputSampleRate, outputSampleRate) {
  if (outputSampleRate === inputSampleRate) return buffer.slice(0);
  if (outputSampleRate > inputSampleRate) {
    throw new Error("outputSampleRate must be <= inputSampleRate");
  }

  const ratio = inputSampleRate / outputSampleRate;
  const newLength = Math.floor(buffer.length / ratio);
  const result = new Float32Array(newLength);
  let offsetResult = 0;
  let offsetBuffer = 0;

  while (offsetResult < result.length) {
    const nextOffsetBuffer = Math.round((offsetResult + 1) * ratio);
    let accum = 0;
    let count = 0;
    for (let i = offsetBuffer; i < nextOffsetBuffer && i < buffer.length; i++) {
      accum += buffer[i];
      count++;
    }
    result[offsetResult] = count > 0 ? accum / count : 0;
    offsetResult++;
    offsetBuffer = nextOffsetBuffer;
  }

  return result;
}

function appendFloat32(chunk) {
  if (!chunk || chunk.length === 0) return;
  const merged = new Float32Array(pcmBuffer.length + chunk.length);
  merged.set(pcmBuffer, 0);
  merged.set(chunk, pcmBuffer.length);
  pcmBuffer = merged;
}

function float32ToInt16(buffer) {
  const out = new Int16Array(buffer.length);
  for (let i = 0; i < buffer.length; i++) {
    const sample = Math.max(-1, Math.min(1, buffer[i]));
    out[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return out;
}

async function flushBufferedAudio(force = false) {
  if (flushing || (!force && pcmBuffer.length < FLUSH_SAMPLES)) return;
  flushing = true;
  try {
    while (pcmBuffer.length >= FLUSH_SAMPLES || (force && pcmBuffer.length > 0)) {
      const take = force && pcmBuffer.length < FLUSH_SAMPLES ? pcmBuffer.length : FLUSH_SAMPLES;
      const chunk = pcmBuffer.slice(0, take);
      pcmBuffer = pcmBuffer.slice(take);

      const endT = await sampleVideoTime();
      const duration = chunk.length / STREAM_SAMPLE_RATE;
      const startT = Math.max(0, endT - duration);
      const payload = float32ToInt16(chunk);

      const res = await fetch(`${BACKEND_URL}/stream/${encodeURIComponent(sessionId)}/chunk?video_time_offset=${encodeURIComponent(startT)}&video_time_end=${encodeURIComponent(endT)}`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: payload.buffer,
      });
      if (!res.ok) {
        console.error(`Live stream chunk upload failed: ${res.status}`);
      }
    }
  } finally {
    flushing = false;
  }
}

async function stopCapture() {
  stopping = true;
  try {
    await flushBufferedAudio(true);
  } catch (err) {
    console.error("final flush failed:", err);
  }

  try {
    await fetch(`${BACKEND_URL}/stream/${encodeURIComponent(sessionId)}/stop`, { method: "POST" });
  } catch (_) {}

  cleanup();
}

function cleanup() {
  if (processorNode) {
    try {
      processorNode.disconnect();
    } catch (_) {}
    processorNode.onaudioprocess = null;
    processorNode = null;
  }
  if (sourceNode) {
    try {
      sourceNode.disconnect();
    } catch (_) {}
    sourceNode = null;
  }
  if (audioCtx) {
    audioCtx.close().catch(() => {});
    audioCtx = null;
  }
  if (mediaStream) {
    mediaStream.getTracks().forEach((t) => t.stop());
    mediaStream = null;
  }
  pcmBuffer = new Float32Array(0);
  flushing = false;
  chrome.runtime.sendMessage({ type: "OFFSCREEN_DONE" });
}
