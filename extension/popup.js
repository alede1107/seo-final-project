const prepareBtn = document.getElementById("prepare");
const showBtn = document.getElementById("show");
const hideBtn = document.getElementById("hide");
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
let showing = false;
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
    reading_transcript: "Reading YouTube transcript",
    fetching_audio: "Reading YouTube transcript",
    uploading_transcript: "Sending transcript",
    transcribing: "Transcribing audio",
    matching_signs: "Building ASL gloss and signs",
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
  const response = await chrome.runtime.sendMessage({
    type: "START_CAPTIONS_ONLY",
    videoId,
    sessionId,
    tabId: currentTab.id,
  });
  if (response?.ok === false) throw new Error(response.error || "Could not show captions");

  showing = true;
  showBtn.disabled = true;
  hideBtn.disabled = false;
  statusEl.textContent = "Captions and signs are shown. Press play.";
  statusEl.className = "ready";
  await chrome.storage.session.set({ captionAidShowingVideo: videoId });
}

async function hideCaptions() {
  await chrome.runtime.sendMessage({ type: "STOP_CAPTIONS" });
  showing = false;
  showBtn.disabled = !prepared;
  hideBtn.disabled = true;
  statusEl.textContent = "Captions and signs hidden.";
  statusEl.className = "";
  await chrome.storage.session.remove("captionAidShowingVideo");
}

async function applyPreparedStatus(data) {
  const completePreparation = data.source !== "extension";
  if (data.status === "ready" && completePreparation) {
    prepared = true;
    stopPolling();
    hideProgress();
    prepareBtn.disabled = true;
    prepareBtn.textContent = "Captions prepared";
    showBtn.disabled = showing;
    hideBtn.disabled = !showing;
    statusEl.textContent = showing
      ? "Captions and signs are shown. Press play."
      : "Transcript prepared. Select Show captions.";
    statusEl.className = "ready";
    if (showWhenReady && !showing) {
      showWhenReady = false;
      await showCaptions();
    }
    return;
  }

  if (data.status === "preparing" && completePreparation) {
    prepared = false;
    prepareBtn.disabled = true;
    prepareBtn.textContent = "Preparing captions";
    showBtn.disabled = true;
    hideBtn.disabled = true;
    statusEl.textContent = "Preparing the full transcript before playback...";
    statusEl.className = "recording";
    renderProgress(data.progress || 55, data.stage || "matching_signs");
    return;
  }

  prepared = false;
  stopPolling();
  hideProgress();
  prepareBtn.disabled = false;
  prepareBtn.textContent = "Prepare captions";
  showBtn.disabled = true;
  hideBtn.disabled = true;
  statusEl.className = "";
  if (data.source === "extension") {
    statusEl.textContent = "Earlier captured captions found. Prepare the complete transcript.";
  } else {
    statusEl.textContent = data.status === "error" ? `Preparation failed: ${data.error}` : "";
  }
}

async function getPreparedStatus() {
  const response = await fetch(`${backend}/api/prepare/${encodeURIComponent(videoId)}`, {
    cache: "no-store",
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Could not check caption preparation");
  return data;
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
  if (polling) pollTimer = window.setTimeout(pollPrepared, 1200);
}

function startPolling() {
  if (polling) return;
  polling = true;
  void pollPrepared();
}

async function submitBrowserTranscript() {
  const transcript = await chrome.runtime.sendMessage({
    type: "GET_YOUTUBE_TRANSCRIPT",
    videoId,
    tabId: currentTab.id,
  });
  if (!transcript?.ok) throw new Error(transcript?.error || "Transcript unavailable in tab");
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
  if (!response.ok) throw new Error(data.error || "Caption transcript upload failed");
  return data;
}

async function submitBackendPreparation() {
  statusEl.textContent = "Resolving the complete transcript...";
  renderProgress(25, "reading_transcript");
  const response = await fetch(`${backend}/api/prepare`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ video_id: videoId }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Caption preparation failed");
  return data;
}

async function init() {
  [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  videoId = extractVideoId(currentTab?.url || "");
  if (!videoId) {
    videoIdEl.textContent = "Open a YouTube video first";
    statusEl.textContent = "CaptionAid needs a YouTube video.";
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

  const stored = await chrome.storage.session.get("captionAidShowingVideo");
  showing = stored.captionAidShowingVideo === videoId;
  prepareBtn.disabled = false;
  try {
    const data = await getPreparedStatus();
    await applyPreparedStatus(data);
    if (data.status === "preparing" && data.source !== "extension") startPolling();
  } catch (_) {
    statusEl.textContent = "Could not check whether this transcript is prepared.";
  }
}

prepareBtn.addEventListener("click", async () => {
  prepareBtn.disabled = true;
  showBtn.disabled = true;
  hideBtn.disabled = true;
  showWhenReady = true;
  statusEl.className = "recording";
  statusEl.textContent = "Reading the complete YouTube transcript...";
  renderProgress(15, "reading_transcript");

  let browserError = null;
  try {
    let data;
    try {
      data = await submitBrowserTranscript();
    } catch (error) {
      browserError = error;
      data = await submitBackendPreparation();
    }

    await applyPreparedStatus(data);
    if (data.status === "preparing") startPolling();
  } catch (error) {
    showWhenReady = false;
    prepared = false;
    stopPolling();
    hideProgress();
    prepareBtn.disabled = false;
    prepareBtn.textContent = "Prepare captions";
    showBtn.disabled = true;
    hideBtn.disabled = true;
    statusEl.className = "";
    const fallbackNote = browserError ? " The in-tab transcript was also unavailable." : "";
    statusEl.textContent = `Error: ${error.message}.${fallbackNote}`.replace("..", ".");
  }
});

showBtn.addEventListener("click", async () => {
  try {
    await showCaptions();
  } catch (error) {
    showBtn.disabled = false;
    statusEl.textContent = `Error: ${error.message}`;
  }
});

hideBtn.addEventListener("click", async () => {
  try {
    await hideCaptions();
  } catch (error) {
    statusEl.textContent = `Error: ${error.message}`;
  }
});

init().catch((error) => {
  statusEl.textContent = `Error: ${error.message}`;
});
