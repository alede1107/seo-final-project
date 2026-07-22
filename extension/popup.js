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
const prepareProgressEl = document.getElementById("prepare-progress");
const prepareStageEl = document.getElementById("prepare-stage");
const preparePercentEl = document.getElementById("prepare-percent");
const prepareProgressTrackEl = document.getElementById("prepare-progress-track");
const prepareProgressFillEl = document.getElementById("prepare-progress-fill");

let currentTab = null;
let videoId = null;
let prepared = false; // true once the whole video is transcribed server-side
let prepareTimer = null;
let prepareEstimateTimer = null;
let prepareEstimateStartedAt = null;
let prepareProcessingStartedAt = null;
let preparePhase = null;

function prepareEstimateKey() {
  return `prepareEstimate:${videoId}`;
}

async function restorePrepareEstimate() {
  const key = prepareEstimateKey();
  const stored = await chrome.storage.session.get(key);
  const estimate = stored[key];
  if (!estimate) return;

  prepareEstimateStartedAt = estimate.startedAt || null;
  prepareProcessingStartedAt = estimate.processingStartedAt || null;
}

function savePrepareEstimate() {
  if (!videoId || !prepareEstimateStartedAt) return;

  chrome.storage.session.set({
    [prepareEstimateKey()]: {
      startedAt: prepareEstimateStartedAt,
      processingStartedAt: prepareProcessingStartedAt,
    },
  });
}

function renderPrepareEstimate() {
  if (!preparePhase || !prepareEstimateStartedAt) return;

  const now = Date.now();
  let percent;
  let stage;

  if (preparePhase === "fetching") {
    const elapsedSeconds = (now - prepareEstimateStartedAt) / 1000;
    percent = Math.min(35, Math.round(5 + elapsedSeconds * 1.5));
    stage = "Fetching video audio";
  } else {
    const processingStartedAt = prepareProcessingStartedAt || now;
    const elapsedSeconds = (now - processingStartedAt) / 1000;
    percent = elapsedSeconds < 75
      ? Math.round(40 + elapsedSeconds * 0.6)
      : Math.round(85 + (elapsedSeconds - 75) * 0.15);
    percent = Math.min(94, percent);
    stage = percent < 85
      ? "Transcribing and matching signs"
      : "Finalizing captions";
  }

  prepareProgressEl.hidden = false;
  prepareStageEl.textContent = stage;
  preparePercentEl.textContent = `${percent}%`;
  prepareProgressTrackEl.setAttribute("aria-valuenow", String(percent));
  prepareProgressFillEl.style.width = `${percent}%`;
}

function startPrepareEstimate(phase) {
  if (!prepareEstimateStartedAt) prepareEstimateStartedAt = Date.now();
  if (phase === "processing" && !prepareProcessingStartedAt) {
    prepareProcessingStartedAt = Date.now();
  }

  preparePhase = phase;
  savePrepareEstimate();
  renderPrepareEstimate();

  if (!prepareEstimateTimer) {
    prepareEstimateTimer = setInterval(renderPrepareEstimate, 500);
  }
}

function stopPrepareEstimate({ clearSaved = false } = {}) {
  if (prepareEstimateTimer) clearInterval(prepareEstimateTimer);
  prepareEstimateTimer = null;
  preparePhase = null;
  prepareProgressEl.hidden = true;

  if (clearSaved && videoId) {
    chrome.storage.session.remove(prepareEstimateKey());
    prepareEstimateStartedAt = null;
    prepareProcessingStartedAt = null;
  }
}

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

  if (videoId) {
    await restorePrepareEstimate();
    await refreshPrepared();
  }
}

// Reflect the server-side prepare state: if the video is already transcribed,
// Start becomes a capture-free "Show captions"; if it's in progress, poll.
async function refreshPrepared() {
  try {
    const res = await fetch(`${BACKEND}/prepare/${encodeURIComponent(videoId)}`);
    if (!res.ok) return;
    const data = await res.json();
    applyPreparedStatus(data.status, data.error);
  } catch (_) {
    // backend down — leave the live-capture path available.
  }
}

function applyPreparedStatus(status, error = null) {
  if (status === "ready") {
    prepared = true;
    preparedEl.textContent = "Captions ready — no capture needed.";
    preparedEl.classList.add("ready");
    prepareBtn.disabled = true;
    prepareBtn.textContent = "Captions prepared";
    startBtn.textContent = "Show captions";
    stopPreparePolling();
    stopPrepareEstimate({ clearSaved: true });
  } else if (status === "preparing") {
    prepared = false;
    preparedEl.textContent = "Preparing captions…";
    preparedEl.classList.remove("ready");
    prepareBtn.disabled = true;
    startPrepareEstimate("processing");
    startPreparePolling();
  } else {
    // "none" or error — offer prepare; live capture stays the default.
    prepared = false;
    preparedEl.textContent = status === "error"
      ? `Prepare failed: ${error || "retry or capture live."}`
      : "";
    preparedEl.classList.remove("ready");
    prepareBtn.disabled = false;
    prepareBtn.textContent = "Prepare captions";
    stopPreparePolling();
    stopPrepareEstimate({ clearSaved: true });
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
  prepareEstimateStartedAt = Date.now();
  prepareProcessingStartedAt = null;
  startPrepareEstimate("fetching");
  prepareBtn.disabled = true;
  preparedEl.textContent = "Requesting…";
  try {
    const res = await fetch(`${BACKEND}/prepare`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ video_id: videoId }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Caption preparation failed");
    applyPreparedStatus(data.status || "preparing");
  } catch (err) {
    preparedEl.textContent = `Error: ${err.message}`;
    prepareBtn.disabled = false;
    stopPrepareEstimate({ clearSaved: true });
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
