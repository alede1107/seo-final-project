// The popup owns the user gesture required by tabCapture. The offscreen
// document keeps recording after this popup closes.

const startBtn = document.getElementById("start");
const stopBtn = document.getElementById("stop");
const statusEl = document.getElementById("status");
const videoIdEl = document.getElementById("video-id");

let currentTab = null;
let videoId = null;

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

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTab = tab;
  videoId = extractVideoId(tab?.url || "");

  if (!videoId) {
    videoIdEl.textContent = "Open a YouTube video first";
    statusEl.textContent = "CaptionAid only captures YouTube video tabs.";
    return;
  }

  videoIdEl.textContent = `Video: ${videoId}`;
  const backend = await globalThis.CaptionAidConfig.resolveBackend();
  try {
    const response = await fetch(`${backend}/health`, { cache: "no-store" });
    if (!response.ok) throw new Error("Backend unavailable");
  } catch (_) {
    statusEl.textContent = "Caption service is unavailable. Try again shortly.";
    return;
  }

  const { recording } = await chrome.storage.session.get("recording");
  startBtn.disabled = Boolean(recording);
  stopBtn.disabled = !recording;
  if (recording) {
    statusEl.textContent = "Preparing captions from this tab...";
    statusEl.classList.add("recording");
  }
}

startBtn.addEventListener("click", async () => {
  startBtn.disabled = true;
  statusEl.textContent = "Connecting to this YouTube tab...";

  try {
    const streamId = await chrome.tabCapture.getMediaStreamId({
      targetTabId: currentTab.id,
    });
    const sessionId = `${videoId}-${Date.now()}`;

    await chrome.runtime.sendMessage({
      type: "START_CAPTURE",
      streamId,
      videoId,
      videoTitle: cleanVideoTitle(currentTab.title),
      sessionId,
      tabId: currentTab.id,
    });

    await chrome.storage.session.set({ recording: true });
    stopBtn.disabled = false;
    statusEl.textContent = "Preparing captions. Keep the video playing.";
    statusEl.classList.add("recording");
  } catch (error) {
    startBtn.disabled = false;
    statusEl.textContent = `Error: ${error.message}`;
  }
});

stopBtn.addEventListener("click", async () => {
  stopBtn.disabled = true;
  await chrome.runtime.sendMessage({ type: "STOP_CAPTURE" });
  await chrome.storage.session.set({ recording: false });
  startBtn.disabled = false;
  statusEl.textContent = "Capture stopped. Final captions may take a few seconds.";
  statusEl.classList.remove("recording");
});

init().catch((error) => {
  statusEl.textContent = `Error: ${error.message}`;
});
