// Orchestration only. It cannot hold a MediaStream, so it:
//   - creates/destroys the offscreen document (which does the capturing)
//   - reads the video's currentTime from the content script at capture start
//     (for time alignment) and hands it to the offscreen doc
//   - tells the content script to start rendering/polling captions

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

async function ensureContentScript(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
  } catch (err) {
    console.warn("content script injection skipped:", err.message);
  }
}

async function getVideoTime(tabId) {
  try {
    const resp = await chrome.tabs.sendMessage(tabId, { type: "GET_VIDEO_TIME" });
    return resp && typeof resp.videoTime === "number" ? resp.videoTime : 0;
  } catch (_) {
    return 0; // no <video> or content script not ready — start from 0
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (msg.type === "START_CAPTURE") {
      await ensureContentScript(msg.tabId);

      await ensureOffscreenDocument();
      await chrome.runtime.sendMessage({
        type: "OFFSCREEN_START",
        target: "offscreen",
        streamId: msg.streamId,
        videoId: msg.videoId,
        sessionId: msg.sessionId,
      });

      // Kick off caption rendering + polling in the page.
      chrome.tabs
        .sendMessage(msg.tabId, {
          type: "CAPTIONS_START",
          videoId: msg.videoId,
          sessionId: msg.sessionId,
        })
        .catch(() => {});

      await chrome.storage.session.set({ recording: true, tabId: msg.tabId });
      sendResponse({ ok: true });
    }

    // Prepared video: captions already exist server-side, so skip capture
    // entirely and just start the overlay. No offscreen doc, no recording flag.
    if (msg.type === "START_CAPTIONS_ONLY") {
      await ensureContentScript(msg.tabId);
      chrome.tabs
        .sendMessage(msg.tabId, {
          type: "CAPTIONS_START",
          videoId: msg.videoId,
          sessionId: msg.sessionId,
        })
        .catch(() => {});
      await chrome.storage.session.set({ tabId: msg.tabId });
      sendResponse({ ok: true });
    }

    // Offscreen asks for the video's live currentTime at a chunk boundary.
    // Relay to the content script (only it can read the <video> element).
    if (msg.type === "SAMPLE_VIDEO_TIME") {
      const { tabId } = await chrome.storage.session.get("tabId");
      const videoTime = tabId ? await getVideoTime(tabId) : 0;
      sendResponse({ videoTime });
    }

    if (msg.type === "STOP_CAPTURE") {
      if (await hasOffscreenDocument()) {
        await chrome.runtime.sendMessage({ type: "OFFSCREEN_STOP", target: "offscreen" });
      }
      const { tabId } = await chrome.storage.session.get("tabId");
      if (tabId) chrome.tabs.sendMessage(tabId, { type: "CAPTIONS_STOP" }).catch(() => {});
      sendResponse({ ok: true });
    }

    // Offscreen doc has fully cleaned up; close it to free memory.
    if (msg.type === "OFFSCREEN_DONE") {
      if (await hasOffscreenDocument()) await chrome.offscreen.closeDocument();
      await chrome.storage.session.set({ recording: false });
    }
  })();
  return true; // keep the channel open for async sendResponse
});