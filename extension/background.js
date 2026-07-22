// Orchestration only. It cannot hold a MediaStream, so it:
//   - creates/destroys the offscreen document (which does the capturing)
//   - reads the video's currentTime from the content script at capture start
//     (for time alignment) and hands it to the offscreen doc
//   - tells the content script to start rendering/polling captions

importScripts("youtube_transcript.js");

const OFFSCREEN_URL = "offscreen.html";
const NATIVE_CAPTION_STORAGE_KEY = "captionAidNativeCaptionTrack";
let latestNativeCaptionTrack = null;
const nativeCaptionWaiters = new Map();

function rememberNativeCaptionTrack(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const videoId = url.searchParams.get("v");
    if (!videoId || !url.searchParams.has("pot")) return;
    latestNativeCaptionTrack = { videoId, url: rawUrl };
    chrome.storage.session
      .set({ [NATIVE_CAPTION_STORAGE_KEY]: latestNativeCaptionTrack })
      .catch(() => {});
    const waiters = nativeCaptionWaiters.get(videoId);
    if (waiters) {
      nativeCaptionWaiters.delete(videoId);
      for (const resolve of waiters) resolve(rawUrl);
    }
  } catch (_) {}
}

chrome.webRequest.onBeforeRequest.addListener(
  (details) => rememberNativeCaptionTrack(details.url),
  { urls: ["https://www.youtube.com/api/timedtext*"] },
);

async function cachedNativeCaptionTrack(videoId) {
  let track = latestNativeCaptionTrack;
  if (track?.videoId !== videoId) {
    const stored = await chrome.storage.session.get(NATIVE_CAPTION_STORAGE_KEY);
    track = stored[NATIVE_CAPTION_STORAGE_KEY] || null;
  }
  if (track?.videoId !== videoId || !track.url) return null;
  try {
    const expiresAt = Number(new URL(track.url).searchParams.get("expire"));
    if (Number.isFinite(expiresAt) && expiresAt <= Date.now() / 1000 + 60) return null;
  } catch (_) {
    return null;
  }
  latestNativeCaptionTrack = track;
  return track.url;
}

function waitForNativeCaptionTrack(videoId, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const waiters = nativeCaptionWaiters.get(videoId) || new Set();
    const finish = (url) => {
      clearTimeout(timer);
      waiters.delete(finish);
      if (!waiters.size) nativeCaptionWaiters.delete(videoId);
      resolve(url);
    };
    const timer = setTimeout(() => {
      waiters.delete(finish);
      if (!waiters.size) nativeCaptionWaiters.delete(videoId);
      reject(new Error("YouTube did not issue an authorized caption request"));
    }, timeoutMs);
    waiters.add(finish);
    nativeCaptionWaiters.set(videoId, waiters);
  });
}

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

async function readNativeYouTubeTranscript(tabId, expectedVideoId) {
  const cachedTrackUrl = await cachedNativeCaptionTrack(expectedVideoId);
  const captionRequest = cachedTrackUrl
    ? Promise.resolve(cachedTrackUrl)
    : waitForNativeCaptionTrack(expectedVideoId, 70_000);

  const playerRequest = chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    args: [expectedVideoId, !cachedTrackUrl],
    func: async (videoId, shouldRequestTrack) => {
      const sleep = (milliseconds) =>
        new Promise((resolve) => window.setTimeout(resolve, milliseconds));
      const player = document.getElementById("movie_player");
      const video = document.querySelector("video");
      let playerResponse = null;
      try {
        playerResponse = player?.getPlayerResponse?.() || window.ytInitialPlayerResponse;
        if (typeof playerResponse === "string") playerResponse = JSON.parse(playerResponse);
      } catch (_) {
        playerResponse = null;
      }
      if (playerResponse?.videoDetails?.videoId !== videoId || !video) {
        return { ok: false, error: "The YouTube video is not ready. Refresh and try again." };
      }

      const metadata = {
        ok: true,
        title: playerResponse.videoDetails?.title || document.title,
        duration: Number(playerResponse.videoDetails?.lengthSeconds) || Number(video.duration),
      };
      if (!shouldRequestTrack) return metadata;

      let button = document.querySelector(".ytp-subtitles-button");
      if (!button) return { ok: false, error: "This video has no YouTube captions." };

      const wasPaused = video.paused;
      const wasMuted = video.muted;
      const originalTime = video.currentTime;
      const captionsWereOn = button.getAttribute("aria-pressed") === "true";

      if (wasPaused) {
        video.muted = true;
        try {
          player?.playVideo?.();
        } catch (_) {}
      }
      try {
        await video.play();
      } catch (_) {}
      await sleep(300);

      for (let attempt = 0; attempt < 120 && player?.classList?.contains("ad-showing"); attempt += 1) {
        const skipButton = document.querySelector(
          ".ytp-skip-ad-button, .ytp-ad-skip-button-modern, .ytp-ad-skip-button",
        );
        skipButton?.click();
        await sleep(500);
      }
      if (player?.classList?.contains("ad-showing")) {
        return { ok: false, error: "Wait for the YouTube ad to finish, then try again." };
      }

      button = document.querySelector(".ytp-subtitles-button");
      if (!button) return { ok: false, error: "This video has no YouTube captions." };
      if (button.getAttribute("aria-pressed") === "true") {
        button.click();
        await sleep(100);
      }
      button = document.querySelector(".ytp-subtitles-button");
      if (button?.getAttribute("aria-pressed") !== "true") button?.click();
      await sleep(1500);

      if (wasPaused) {
        video.pause();
        video.currentTime = originalTime;
      }
      video.muted = wasMuted;
      if (!captionsWereOn && button?.getAttribute("aria-pressed") === "true") button.click();

      return metadata;
    },
  });

  const [trackUrl, results] = await Promise.all([captionRequest, playerRequest]);
  const metadata = results[0]?.result;
  if (!metadata?.ok) throw new Error(metadata?.error || "YouTube captions are unavailable");

  const response = await fetch(trackUrl, {
    credentials: "include",
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`YouTube captions returned ${response.status}`);
  const body = await response.text();
  if (!body.trim()) throw new Error("YouTube returned an empty authorized caption track");

  const captions = globalThis.CaptionAidYouTube.json3Cues(JSON.parse(body));
  if (!captions.length) throw new Error("YouTube returned no transcript text");
  const duration = Number.isFinite(metadata.duration) && metadata.duration > 0
    ? metadata.duration
    : captions[captions.length - 1].end;
  return {
    ok: true,
    videoId: expectedVideoId,
    title: metadata.title,
    duration,
    language: "YouTube captions",
    captions,
  };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (msg.type === "GET_YOUTUBE_TRANSCRIPT") {
      let transcriptError = null;
      try {
        sendResponse(await globalThis.CaptionAidYouTube.fetchTranscript(msg.videoId));
        return;
      } catch (error) {
        transcriptError = error;
      }
      try {
        const transcript = await readYouTubeTranscript(msg.tabId, msg.videoId);
        if (transcript?.ok) {
          sendResponse(transcript);
          return;
        }
        transcriptError = new Error(transcript?.error || "YouTube captions are unavailable");
      } catch (error) {
        transcriptError = error;
      }
      try {
        sendResponse(await readNativeYouTubeTranscript(msg.tabId, msg.videoId));
      } catch (error) {
        sendResponse({
          ok: false,
          error: error?.message || transcriptError?.message || "YouTube captions are unavailable",
        });
      }
      return;
    }

    if (msg.type === "GET_YOUTUBE_TRANSCRIPT_REMOTE") {
      try {
        sendResponse(await globalThis.CaptionAidYouTube.fetchTranscript(msg.videoId));
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
