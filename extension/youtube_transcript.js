(() => {
  const SAFE_VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
  const ANDROID_VR_CLIENT = {
    clientName: "ANDROID_VR",
    clientVersion: "1.65.10",
    deviceMake: "Oculus",
    deviceModel: "Quest 3",
    androidSdkVersion: 32,
    userAgent: "com.google.android.apps.youtube.vr.oculus/1.65.10 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip",
    osName: "Android",
    osVersion: "12L",
    hl: "en",
    timeZone: "UTC",
    utcOffsetMinutes: 0,
  };

  function parseObjectAt(source, start) {
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let index = start; index < source.length; index += 1) {
      const character = source[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') inString = true;
      else if (character === "{") depth += 1;
      else if (character === "}") {
        depth -= 1;
        if (depth === 0) return JSON.parse(source.slice(start, index + 1));
      }
    }
    return null;
  }

  function extractPlayerResponse(html, videoId) {
    const markers = [
      "ytInitialPlayerResponse =",
      "ytInitialPlayerResponse=",
      'window["ytInitialPlayerResponse"] =',
    ];

    for (const marker of markers) {
      let cursor = 0;
      while (cursor < html.length) {
        const markerIndex = html.indexOf(marker, cursor);
        if (markerIndex < 0) break;
        const start = html.indexOf("{", markerIndex + marker.length);
        if (start < 0) break;
        try {
          const candidate = parseObjectAt(html, start);
          if (candidate?.videoDetails?.videoId === videoId) return candidate;
        } catch (_) {}
        cursor = markerIndex + marker.length;
      }
    }
    return null;
  }

  function extractVisitorData(html) {
    const match = html.match(/"(?:VISITOR_DATA|visitorData)":"((?:\\.|[^"\\])*)"/);
    if (!match) return "";
    try {
      return JSON.parse(`"${match[1]}"`);
    } catch (_) {
      return match[1];
    }
  }

  function trackName(track) {
    return track?.name?.simpleText ||
      (track?.name?.runs || []).map((run) => run.text || "").join("") ||
      track?.languageCode ||
      "captions";
  }

  function selectTrack(playerResponse) {
    const tracks = playerResponse.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
    const english = tracks.filter((track) =>
      String(track.languageCode || "").toLowerCase().startsWith("en"),
    );
    let translated = false;
    let track = english.find((candidate) => candidate.kind !== "asr") || english[0];
    if (!track) {
      track = tracks.find((candidate) => candidate.isTranslatable);
      translated = Boolean(track);
    }
    return { track, translated };
  }

  function json3Cues(timedText) {
    const raw = (timedText.events || [])
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

    return raw.map((cue, index) => {
      const nextStart = raw[index + 1]?.start;
      let end = cue.start + cue.duration;
      if (!Number.isFinite(end) || end <= cue.start) {
        end = Number.isFinite(nextStart) && nextStart > cue.start ? nextStart : cue.start + 2;
      }
      return { start: cue.start, end, text: cue.text };
    });
  }

  async function fetchWatchPage(videoId) {
    const pages = [
      `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&hl=en`,
      `https://www.youtube.com/embed/${encodeURIComponent(videoId)}?hl=en`,
    ];
    let lastError = "YouTube did not return player data";

    for (const page of pages) {
      try {
        const response = await fetch(page, {
          credentials: "include",
          cache: "no-store",
          headers: { "Accept-Language": "en-US,en;q=0.9" },
        });
        if (!response.ok) {
          lastError = `YouTube returned ${response.status}`;
          continue;
        }
        const html = await response.text();
        const playerResponse = extractPlayerResponse(html, videoId);
        if (playerResponse) return { html, playerResponse };
      } catch (error) {
        lastError = error.message;
      }
    }
    throw new Error(lastError);
  }

  async function fetchAndroidPlayerResponse(videoId, visitorData) {
    const client = { ...ANDROID_VR_CLIENT };
    if (visitorData) client.visitorData = visitorData;

    const headers = {
      "Content-Type": "application/json",
      "X-YouTube-Client-Name": "28",
      "X-YouTube-Client-Version": ANDROID_VR_CLIENT.clientVersion,
    };
    if (visitorData) headers["X-Goog-Visitor-Id"] = visitorData;

    const response = await fetch(
      "https://www.youtube.com/youtubei/v1/player?prettyPrint=false",
      {
        method: "POST",
        cache: "no-store",
        headers,
        body: JSON.stringify({
          context: { client },
          videoId,
          playbackContext: {
            contentPlaybackContext: { html5Preference: "HTML5_PREF_WANTS" },
          },
          contentCheckOk: true,
          racyCheckOk: true,
        }),
      },
    );
    if (!response.ok) throw new Error(`YouTube player returned ${response.status}`);

    const playerResponse = await response.json();
    if (playerResponse.videoDetails?.videoId === videoId) return playerResponse;
    throw new Error(
      playerResponse.playabilityStatus?.reason || "YouTube did not return this video",
    );
  }

  async function fetchPlayerResponse(videoId) {
    const { html, playerResponse: webPlayerResponse } = await fetchWatchPage(videoId);
    const visitorData = extractVisitorData(html);

    try {
      return await fetchAndroidPlayerResponse(videoId, visitorData);
    } catch (error) {
      const hasTracks = selectTrack(webPlayerResponse).track?.baseUrl;
      if (hasTracks) return webPlayerResponse;
      throw error;
    }
  }

  async function fetchTranscript(videoId) {
    if (!SAFE_VIDEO_ID.test(videoId || "")) throw new Error("Invalid YouTube video ID");
    const playerResponse = await fetchPlayerResponse(videoId);
    const { track, translated } = selectTrack(playerResponse);
    if (!track?.baseUrl) throw new Error("This video has no usable YouTube caption track");

    const trackUrl = new URL(track.baseUrl);
    trackUrl.searchParams.set("fmt", "json3");
    if (translated) trackUrl.searchParams.set("tlang", "en");

    const response = await fetch(trackUrl.toString(), {
      credentials: "include",
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`YouTube captions returned ${response.status}`);
    const body = await response.text();
    if (!body.trim()) throw new Error("YouTube returned an empty caption track");

    const captions = json3Cues(JSON.parse(body));
    if (!captions.length) throw new Error("YouTube returned no transcript text");
    const reportedDuration = Number(playerResponse.videoDetails?.lengthSeconds);
    const duration = Number.isFinite(reportedDuration) && reportedDuration > 0
      ? reportedDuration
      : captions[captions.length - 1].end;

    return {
      ok: true,
      videoId,
      title: playerResponse.videoDetails?.title || `YouTube video ${videoId}`,
      duration,
      language: translated ? "English (translated)" : trackName(track),
      captions,
    };
  }

  globalThis.CaptionAidYouTube = {
    extractPlayerResponse,
    extractVisitorData,
    fetchTranscript,
    json3Cues,
  };
})();
