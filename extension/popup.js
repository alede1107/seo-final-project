const startBtn = document.getElementById("start");
const stopBtn = document.getElementById("stop");
const statusEl = document.getElementById("status");
const videoIdEl = document.getElementById("video-id");
const progressEl = document.getElementById("progress");
const progressStageEl = document.getElementById("progress-stage");
const progressPercentEl = document.getElementById("progress-percent");
const progressTrackEl = document.getElementById("progress-track");
const progressFillEl = document.getElementById("progress-fill");

let backend = null;
let currentTab = null;
let videoId = null;
let prepared = false;
let polling = false;
let pollTimer = null;
let showWhenReady = false;

function extractVideoId(url) {
  try {
    const parsed = new URL(url);
    if (parsed.hostname.includes("youtube.com")) return parsed.searchParams.get("v");
    if (parsed.hostname === "youtu.be") return parsed.pathname.slice(1);
  } catch (_) {}
  return null;
}

function cleanVideoTitle(title) {
  return String(title || "").replace(/\s+-\s+YouTube\s*$/i, "").trim();
}

function stageLabel(stage) {
  return {
    reading_transcript: "Reading transcript",
    uploading_transcript: "Sending transcript",
    matching_signs: "Building gloss and signs",
    ready: "Captions ready",
  }[stage] || "Preparing captions";
}

function renderProgress(progress, stage) {
  const value = Math.max(0, Math.min(100, Math.round(Number(progress) || 0)));
  progressEl.hidden = false;
  progressStageEl.textContent = stageLabel(stage);
  progressPercentEl.textContent = `${value}%`;
  progressTrackEl.setAttribute("aria-valuenow", String(value));
  progressFillEl.style.width = `${value}%`;
}

function hideProgress() {
  progressEl.hidden = true;
}

function stopPolling() {
  polling = false;
  if (pollTimer) window.clearTimeout(pollTimer);
  pollTimer = null;
}

async function showCaptions() {
  const sessionId = `view-${videoId}-${Date.now()}`;
  await chrome.runtime.sendMessage({
    type: "START_CAPTIONS_ONLY",
    videoId,
    sessionId,
    tabId: currentTab.id,
  });
  startBtn.disabled = true;
  stopBtn.disabled = false;
  statusEl.textContent = "Captions and signs are ready. Press play.";
  statusEl.className = "ready";
}

async function applyPreparedStatus(data) {
  const isPreparedJob = data.source !== "extension";
  if (data.status === "ready" && isPreparedJob) {
    prepared = true;
    stopPolling();
    hideProgress();
    startBtn.disabled = false;
    startBtn.textContent = "Show captions";
    statusEl.textContent = "Transcript prepared.";
    statusEl.className = "ready";
    if (showWhenReady) {
      showWhenReady = false;
      await showCaptions();
    }
    return;
  }

  if (data.status === "preparing" && isPreparedJob) {
    prepared = false;
    startBtn.disabled = true;
    statusEl.textContent = "Preparing the full transcript before playback...";
    statusEl.className = "recording";
    renderProgress(data.progress || 65, data.stage || "matching_signs");
    return;
  }

  prepared = false;
  stopPolling();
  hideProgress();
  startBtn.disabled = false;
  startBtn.textContent = "Prepare captions";
  statusEl.className = "";
  statusEl.textContent = data.status === "error" ? `Preparation failed: ${data.error}` : "";
}

async function getPreparedStatus() {
  const response = await fetch(`${backend}/api/prepare/${encodeURIComponent(videoId)}`, {
    cache: "no-store",
  });
  if (!response.ok) throw new Error("Could not check caption preparation");
  return response.json();
}

async function pollPrepared() {
  if (!polling) return;
  try {
    const data = await getPreparedStatus();
    await applyPreparedStatus(data);
    if (data.status === "error") showWhenReady = false;
  } catch (error) {
    statusEl.textContent = `Error: ${error.message}`;
  }
  if (polling) pollTimer = window.setTimeout(pollPrepared, 1500);
}

function startPolling() {
  if (polling) return;
  polling = true;
  void pollPrepared();
}

async function init() {
  [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  videoId = extractVideoId(currentTab?.url || "");
  if (!videoId) {
    videoIdEl.textContent = "Open a YouTube video first";
    statusEl.textContent = "CaptionAid needs a YouTube video with captions.";
    return;
  }

  videoIdEl.textContent = `Video: ${videoId}`;
  backend = await globalThis.CaptionAidConfig.resolveBackend();
  try {
    const response = await fetch(`${backend}/api/health`, { cache: "no-store" });
    if (!response.ok) throw new Error("Backend unavailable");
  } catch (_) {
    statusEl.textContent = "Caption service is unavailable. Try again shortly.";
    return;
  }

  startBtn.disabled = false;
  try {
    const data = await getPreparedStatus();
    await applyPreparedStatus(data);
    if (data.status === "preparing" && data.source !== "extension") startPolling();
  } catch (_) {
    statusEl.textContent = "Could not check whether this transcript is prepared.";
  }
}

startBtn.addEventListener("click", async () => {
  if (prepared) {
    try {
      await showCaptions();
    } catch (error) {
      startBtn.disabled = false;
      statusEl.textContent = `Error: ${error.message}`;
    }
    return;
  }

  startBtn.disabled = true;
  showWhenReady = true;
  statusEl.className = "recording";
  statusEl.textContent = "Reading the complete YouTube transcript...";
  renderProgress(15, "reading_transcript");

  try {
    const transcript = await chrome.runtime.sendMessage({
      type: "GET_YOUTUBE_TRANSCRIPT",
      videoId,
      tabId: currentTab.id,
    });
    if (!transcript?.ok) throw new Error(transcript?.error || "Transcript unavailable");
    if (transcript.videoId !== videoId) throw new Error("The YouTube video changed. Try again.");

    statusEl.textContent = `Found ${transcript.captions.length} timed caption lines.`;
    renderProgress(45, "uploading_transcript");
    const response = await fetch(`${backend}/api/prepare/transcript`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        video_id: videoId,
        title: cleanVideoTitle(transcript.title || currentTab.title),
        duration: transcript.duration,
        captions: transcript.captions,
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Caption preparation failed");

    await applyPreparedStatus(data);
    startPolling();
  } catch (error) {
    showWhenReady = false;
    prepared = false;
    stopPolling();
    hideProgress();
    startBtn.disabled = false;
    startBtn.textContent = "Prepare captions";
    statusEl.className = "";
    statusEl.textContent = `Error: ${error.message}`;
  }
});

stopBtn.addEventListener("click", async () => {
  stopBtn.disabled = true;
  await chrome.runtime.sendMessage({ type: "STOP_CAPTURE" }).catch(() => {});
  await chrome.runtime.sendMessage({ type: "STOP_CAPTIONS" }).catch(() => {});
  await chrome.storage.session.set({ recording: false });
  startBtn.disabled = false;
  startBtn.textContent = prepared ? "Show captions" : "Prepare captions";
  statusEl.textContent = prepared ? "Captions hidden." : "CaptionAid stopped.";
  statusEl.className = "";
});

init().catch((error) => {
  statusEl.textContent = `Error: ${error.message}`;
});
