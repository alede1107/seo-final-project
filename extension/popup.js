// popup.js
// The popup is where the user gesture happens, which is what authorizes
// tabCapture. We grab a media stream ID here, then hand it to the service
// worker. Once handed off, the popup can close and recording continues
// in the offscreen document.

const startBtn = document.getElementById("start");
const stopBtn = document.getElementById("stop");
const statusEl = document.getElementById("status");
const videoIdEl = document.getElementById("video-id");

let currentTab = null;
let videoId = null;

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
  }

  // Reflect current recording state so reopening the popup shows reality.
  const { recording } = await chrome.storage.session.get("recording");
  if (recording) {
    startBtn.disabled = true;
    stopBtn.disabled = false;
    statusEl.textContent = "Recording...";
    statusEl.classList.add("recording");
  }
}

startBtn.addEventListener("click", async () => {
  try {
    // Must be called in response to a user gesture (this click).
    const streamId = await chrome.tabCapture.getMediaStreamId({
      targetTabId: currentTab.id,
    });

    await chrome.runtime.sendMessage({
      type: "START_CAPTURE",
      streamId,
      videoId,
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
