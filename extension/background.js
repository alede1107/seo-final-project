// background.js (MV3 service worker)
// The service worker CANNOT hold a MediaStream. Its only job here is to
// create/destroy the offscreen document and relay start/stop commands to it.

const OFFSCREEN_URL = "offscreen.html";

async function hasOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
  });
  return contexts.length > 0;
}

async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument()) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ["USER_MEDIA"],
    justification:
      "Capture tab audio via getUserMedia and upload chunks to the backend.",
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (msg.type === "START_CAPTURE") {
      await ensureOffscreenDocument();
      // Forward to the offscreen document. target field lets the offscreen
      // doc ignore messages meant for other contexts.
      await chrome.runtime.sendMessage({
        type: "OFFSCREEN_START",
        target: "offscreen",
        streamId: msg.streamId,
        videoId: msg.videoId,
      });
      sendResponse({ ok: true });
    }

    if (msg.type === "STOP_CAPTURE") {
      if (await hasOffscreenDocument()) {
        await chrome.runtime.sendMessage({
          type: "OFFSCREEN_STOP",
          target: "offscreen",
        });
      }
      sendResponse({ ok: true });
    }

    // Offscreen doc tells us it has fully cleaned up; close it to free memory.
    if (msg.type === "OFFSCREEN_DONE") {
      if (await hasOffscreenDocument()) {
        await chrome.offscreen.closeDocument();
      }
      await chrome.storage.session.set({ recording: false });
    }
  })();
  return true; // keep the message channel open for async sendResponse
});
