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
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["config.js", "content.js"],
    });
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

async function readYouTubeTranscript(tabId, expectedVideoId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    args: [expectedVideoId],
    func: async (videoId) => {
      const sleep = (milliseconds) =>
        new Promise((resolve) => window.setTimeout(resolve, milliseconds));

      let playerResponse = null;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const player = document.getElementById("movie_player");
        let candidate = null;
        try {
          candidate = player?.getPlayerResponse?.() || window.ytInitialPlayerResponse;
          if (typeof candidate === "string") candidate = JSON.parse(candidate);
        } catch (_) {
          candidate = null;
        }

        if (candidate?.videoDetails?.videoId === videoId) {
          playerResponse = candidate;
          break;
        }
        await sleep(250);
      }

      if (!playerResponse) {
        return {
          ok: false,
          error: "YouTube has not finished loading this video. Wait a moment and try again.",
        };
      }

      document.querySelector("video")?.pause();
      const trackList =
        playerResponse.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
      if (!trackList.length) {
        return {
          ok: false,
          error: "This video has no YouTube caption track to prepare.",
        };
      }

      const trackName = (track) =>
        track?.name?.simpleText ||
        (track?.name?.runs || []).map((run) => run.text || "").join("") ||
        track?.languageCode ||
        "captions";
      const englishTracks = trackList.filter((track) =>
        String(track.languageCode || "").toLowerCase().startsWith("en"),
      );
      let translated = false;
      let track =
        englishTracks.find((candidate) => candidate.kind !== "asr") || englishTracks[0];
      if (!track) {
        track = trackList.find((candidate) => candidate.isTranslatable);
        translated = Boolean(track);
      }
      if (!track?.baseUrl) {
        return {
          ok: false,
          error: "This video does not have an English caption track CaptionAid can prepare.",
        };
      }

      // Keep YouTube's signed query string byte-for-byte intact. Rebuilding it
      // through URLSearchParams can make a valid timedtext URL return an empty
      // body even though the video has captions.
      let trackUrl = track.baseUrl;
      if (!/[?&]fmt=/.test(trackUrl)) trackUrl += `${trackUrl.includes("?") ? "&" : "?"}fmt=json3`;
      if (translated && !/[?&]tlang=/.test(trackUrl)) trackUrl += "&tlang=en";

      let timedText;
      try {
        const response = await fetch(trackUrl, {
          credentials: "include",
          cache: "no-store",
        });
        if (!response.ok) throw new Error(`YouTube returned ${response.status}`);
        const body = await response.text();
        if (!body.trim()) throw new Error("YouTube returned an empty caption track");
        timedText = JSON.parse(body);
      } catch (error) {
        return {
          ok: false,
          error: `YouTube captions could not be read: ${error.message}`,
        };
      }

      const rawCues = (timedText.events || [])
        .filter((event) => Array.isArray(event.segs) && event.segs.length)
        .map((event) => ({
          start: Number(event.tStartMs) / 1000,
          duration: Number(event.dDurationMs) / 1000,
          text: event.segs
            .map((segment) => segment.utf8 || "")
            .join("")
            .replace(/[\u200b\u200e\u200f]/g, "")
            .replace(/\s+/g, " ")
            .trim(),
        }))
        .filter((cue) => Number.isFinite(cue.start) && cue.start >= 0 && cue.text);

      const captions = rawCues.map((cue, index) => {
        const nextStart = rawCues[index + 1]?.start;
        let end = cue.start + cue.duration;
        if (!Number.isFinite(end) || end <= cue.start) {
          end = Number.isFinite(nextStart) && nextStart > cue.start
            ? nextStart
            : cue.start + 2;
        }
        return { start: cue.start, end, text: cue.text };
      });

      if (!captions.length) {
        return {
          ok: false,
          error: "YouTube returned a caption track with no transcript text.",
        };
      }

      const pageVideo = document.querySelector("video");
      const reportedDuration = Number(playerResponse.videoDetails?.lengthSeconds);
      const duration = Number.isFinite(reportedDuration) && reportedDuration > 0
        ? reportedDuration
        : Number(pageVideo?.duration) || captions[captions.length - 1].end;

      return {
        ok: true,
        videoId,
        title: playerResponse.videoDetails?.title || document.title,
        duration,
        language: translated ? "English (translated)" : trackName(track),
        captions,
      };
    },
  });

  return results[0]?.result || {
    ok: false,
    error: "CaptionAid could not access this YouTube tab.",
  };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (msg.type === "GET_YOUTUBE_TRANSCRIPT") {
      try {
        sendResponse(await readYouTubeTranscript(msg.tabId, msg.videoId));
      } catch (error) {
        sendResponse({ ok: false, error: error.message });
      }
      return;
    }

    if (msg.type === "START_CAPTURE") {
      await ensureContentScript(msg.tabId);

      await ensureOffscreenDocument();
      await chrome.runtime.sendMessage({
        type: "OFFSCREEN_START",
        target: "offscreen",
        streamId: msg.streamId,
        videoId: msg.videoId,
        videoTitle: msg.videoTitle,
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
      // Keep the content script polling so the last uploaded chunk can finish
      // in AssemblyAI and appear after recording stops.
      sendResponse({ ok: true });
    }

    if (msg.type === "STOP_CAPTIONS") {
      const { tabId } = await chrome.storage.session.get("tabId");
      if (tabId) {
        chrome.tabs.sendMessage(tabId, { type: "CAPTIONS_STOP" }).catch(() => {});
      }
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
