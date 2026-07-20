// popup.js
// The popup is where the user gesture happens, which is what authorizes
// tabCapture. We grab a media stream ID here, then hand it to the service
// worker. Once handed off, the popup can close and recording continues
// in the offscreen document.

const BACKEND = "http://localhost:5001";

const startBtn = document.getElementById("start");
const stopBtn = document.getElementById("stop");
const prepareBtn = document.getElementById("prepare");
const statusEl = document.getElementById("status");
const preparedEl = document.getElementById("prepared");
const videoIdEl = document.getElementById("video-id");

let currentTab = null;
let videoId = null;
let prepared = false; // true once the whole video is transcribed server-side
let prepareTimer = null;

function extractVideoId(url) {
  try {
    const u = new URL(url);
    if (u.hostname.includes("youtube.com")) return u.searchParams.get("v");
    if (u.hostname === "youtu.be") return u.pathname.slice(1);
  } catch (_) {}
  return null;
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTab = tab;
  videoId = extractVideoId(tab.url || "");

  if (videoId) {
    videoIdEl.textContent = `Video: ${videoId}`;
  } else {
    videoIdEl.textContent = "Not a YouTube video page";
    startBtn.disabled = true;
    prepareBtn.disabled = true;
  }

  // Reflect current recording state so reopening the popup shows reality.
  const { recording } = await chrome.storage.session.get("recording");
  if (recording) {
    startBtn.disabled = true;
    stopBtn.disabled = false;
    statusEl.textContent = "Recording...";
    statusEl.classList.add("recording");
  }

  if (videoId) refreshPrepared();
}

// Reflect the server-side prepare state: if the video is already transcribed,
// Start becomes a capture-free "Show captions"; if it's in progress, poll.
async function refreshPrepared() {
  try {
    const res = await fetch(`${BACKEND}/prepare/${encodeURIComponent(videoId)}`);
    if (!res.ok) return;
    const { status } = await res.json();
    applyPreparedStatus(status);
  } catch (_) {
    // backend down — leave the live-capture path available.
  }
}

function applyPreparedStatus(status) {
  if (status === "ready") {
    prepared = true;
    preparedEl.textContent = "Captions ready — no capture needed.";
    preparedEl.classList.add("ready");
    prepareBtn.disabled = true;
    prepareBtn.textContent = "Captions prepared";
    startBtn.textContent = "Show captions";
    stopPreparePolling();
  } else if (status === "preparing") {
    prepared = false;
    preparedEl.textContent = "Preparing captions…";
    preparedEl.classList.remove("ready");
    prepareBtn.disabled = true;
    startPreparePolling();
  } else {
    // "none" or error — offer prepare; live capture stays the default.
    prepared = false;
    preparedEl.textContent = status === "error" ? "Prepare failed — retry or capture live." : "";
    preparedEl.classList.remove("ready");
    prepareBtn.disabled = false;
    prepareBtn.textContent = "Prepare captions";
  }
}

function startPreparePolling() {
  if (prepareTimer) return;
  prepareTimer = setInterval(refreshPrepared, 2000);
}

function stopPreparePolling() {
  if (prepareTimer) clearInterval(prepareTimer);
  prepareTimer = null;
}

prepareBtn.addEventListener("click", async () => {
  prepareBtn.disabled = true;
  preparedEl.textContent = "Requesting…";
  try {
    const res = await fetch(`${BACKEND}/prepare`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ video_id: videoId }),
    });
    const data = await res.json().catch(() => ({}));
    applyPreparedStatus(data.status || "preparing");
  } catch (err) {
    preparedEl.textContent = `Error: ${err.message}`;
    prepareBtn.disabled = false;
  }
});

startBtn.addEventListener("click", async () => {
  try {
    // Prepared video: captions already exist server-side. Skip tabCapture and
    // the offscreen doc — just render the cached captions. A fresh view-only
    // sessionId (distinct from the prepared `pre-<id>` session) lets
    // loadCache() render every prepared row instead of skipping them.
    if (prepared) {
      const sessionId = `view-${videoId}-${Date.now()}`;
      await chrome.runtime.sendMessage({
        type: "START_CAPTIONS_ONLY",
        videoId,
        sessionId,
        tabId: currentTab.id,
      });
      startBtn.disabled = true;
      stopBtn.disabled = false;
      statusEl.textContent = "Showing captions.";
      return;
    }

    // Must be called in response to a user gesture (this click).
    const streamId = await chrome.tabCapture.getMediaStreamId({
      targetTabId: currentTab.id,
    });

    // Generate the session id here, once, and share it with everyone:
    // offscreen tags uploads with it, the content script polls captions by
    // it, the backend keys rows on it.
    const sessionId = `${videoId}-${Date.now()}`;

    await chrome.runtime.sendMessage({
      type: "START_CAPTURE",
      streamId,
      videoId,
      sessionId,
      tabId: currentTab.id,
    });

    await chrome.storage.session.set({ recording: true });
    startBtn.disabled = true;
    stopBtn.disabled = false;
    statusEl.textContent = "Recording...";
    statusEl.classList.add("recording");
  } catch (err) {
    statusEl.textContent = `Error: ${err.message}`;
  }
});

stopBtn.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "STOP_CAPTURE" });
  await chrome.storage.session.set({ recording: false });
  startBtn.disabled = false;
  stopBtn.disabled = true;
  statusEl.textContent = "Stopped.";
  statusEl.classList.remove("recording");
});

init();
