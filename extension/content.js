// Runs on the YouTube page. 
//   1. Report the <video> element's currentTime when the service worker asks
//      (used to align chunks to real video time).
//   2. Render a Shadow-DOM caption overlay, polling the backend for this
//      session's transcripts and (on start) any cached transcripts for the
//      video from previous sessions.

if (!window.__captionAidLoaded) {
  window.__captionAidLoaded = true;

  const BACKEND = "http://localhost:5001";
  const POLL_MS = 2000;

  let pollTimer = null;
  let sessionId = null;
  let videoId = null;
  const seenChunks = new Set(); // chunk_index values already rendered
  let ui = null;

  // Caption text mode: "asl" shows ASL gloss (default), "en" shows English.
  // The sign-clip panel plays regardless of this — it's tied to the gloss, not
  // the displayed text.
  let mode = "asl";

  // Segments in video-time order, each { offset, end, clips: [{token,url}] }.
  // Drives the auto-playing sign-clip panel; populated alongside every line.
  const segments = [];

  function getVideo() {
    return document.querySelector("video");
  }

  function fmtTime(seconds) {
    if (seconds == null || isNaN(seconds)) return "--:--";
    const s = Math.max(0, Math.floor(seconds));
    return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  }

  // --- Overlay (Shadow DOM so YouTube's CSS can't touch it) --------------
  function ensureOverlay() {
    if (ui) return ui;

    const host = document.createElement("div");
    host.id = "captionaid-host";
    host.style.cssText = "position:fixed;top:80px;right:24px;z-index:2147483647;";
    document.documentElement.appendChild(host);

    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `
      <style>
        .box { width: 360px; background: rgba(15,15,18,0.92);
               color: #f2f2f2; border: 1px solid #333; border-radius: 10px;
               font: 13px/1.45 system-ui, sans-serif; box-shadow: 0 8px 28px rgba(0,0,0,.5);
               display: flex; flex-direction: column; overflow: hidden; }
        .bar { display: flex; align-items: center; gap: 8px; padding: 8px 10px;
               background: #1d1d22; cursor: move; user-select: none; flex-shrink: 0; }
        .bar b { font-size: 12px; letter-spacing: .3px; }
        .toggle { margin-left: auto; font-size: 10px; font-weight: 700; letter-spacing: .5px;
                  background: #2b2b33; color: #cfe6ff; border: 1px solid #3a3a44;
                  border-radius: 5px; padding: 2px 7px; cursor: pointer; }
        .toggle:hover { background: #34343d; }
        .hide { font-size: 10px; background: #2b2b33; color: #d8d8df; border: 1px solid #3a3a44;
                border-radius: 5px; padding: 2px 7px; cursor: pointer; }
        .hide:hover { background: #34343d; }
        .lag { font-size: 11px; color: #ffcb6b; }
        .clips { border-bottom: 1px solid #333; padding: 8px; display: none; flex-direction: column;
                 align-items: center; gap: 4px; background: #141418; flex-shrink: 0; }
        .clips.on { display: flex; }
        .clipvid { width: 100%; height: 160px; object-fit: contain; border-radius: 6px; background: #000; }
        .cliplabel { font-size: 11px; color: #9fd0ff; font-variant-numeric: tabular-nums; }
        .list { padding: 6px 4px; overflow-y: auto; max-height: 180px; }
        .line { padding: 5px 8px; border-radius: 6px; cursor: pointer; display: flex; gap: 8px;
                border-left: 2px solid transparent; }
        .line:hover { background: #26262d; }
        .line.current { background: rgba(255, 204, 0, 0.15); border-left-color: #ffcc00; }
        .t { color: #7fbfff; flex: 0 0 44px; font-variant-numeric: tabular-nums; }
        .cached .t { color: #8a8a8a; }
        .txt { flex: 1; }
        .empty { padding: 10px; color: #999; }
      </style>
      <div class="box">
        <div class="bar" part="bar">
          <b>CaptionAid</b>
          <span class="lag" id="lag"></span>
          <button class="toggle" id="toggle" title="Toggle ASL gloss / English">ASL</button>
          <button class="hide" id="hide" type="button">Hide</button>
        </div>
        <div class="clips" id="clips">
          <video class="clipvid" id="clipvid" muted playsinline></video>
          <div class="cliplabel" id="cliplabel"></div>
        </div>
        <div class="list" id="list"><div class="empty">Waiting for captions…</div></div>
      </div>`;

    const listEl = root.getElementById("list");
    const lagEl = root.getElementById("lag");
    const toggleEl = root.getElementById("toggle");
    const hideEl = root.getElementById("hide");
    const clipsEl = root.getElementById("clips");
    const clipVid = root.getElementById("clipvid");
    const clipLabel = root.getElementById("cliplabel");
    makeDraggable(host, root.querySelector(".bar"));

    const launcher = document.createElement("button");
    launcher.type = "button";
    launcher.textContent = "CaptionAid";
    launcher.style.cssText =
      "position:fixed;right:24px;top:80px;z-index:2147483647;display:none;" +
      "background:#1d1d22;color:#f2f2f2;border:1px solid #333;border-radius:999px;" +
      "padding:8px 12px;font:12px/1.2 system-ui,sans-serif;cursor:pointer;" +
      "box-shadow:0 8px 28px rgba(0,0,0,.35);";
    document.documentElement.appendChild(launcher);

    ui = {
      host,
      root,
      listEl,
      lagEl,
      toggleEl,
      hideEl,
      clipsEl,
      clipVid,
      clipLabel,
      launcher,
      empty: true,
    };

    // A click on the toggle must not start a drag on the bar.
    toggleEl.addEventListener("mousedown", (e) => e.stopPropagation());
    toggleEl.addEventListener("click", () => setMode(mode === "asl" ? "en" : "asl"));
    hideEl.addEventListener("mousedown", (e) => e.stopPropagation());
    hideEl.addEventListener("click", () => setOverlayVisible(false));
    launcher.addEventListener("click", () => setOverlayVisible(true));

    // Advance the clip queue when the current clip finishes.
    clipVid.addEventListener("ended", playNextClip);

    return ui;
  }

  function setOverlayVisible(visible) {
    const overlay = ensureOverlay();
    overlay.host.style.display = visible ? "block" : "none";
    overlay.launcher.style.display = visible ? "none" : "block";
  }

  // --- Caption text mode (ASL gloss vs English) --------------------------
  function lineText(chunk) {
    const gloss = Array.isArray(chunk.gloss) ? chunk.gloss.join(" ") : "";
    // Fall back to English if a chunk has no gloss (e.g. all-stopword span).
    return mode === "asl" && gloss ? gloss : (chunk.text || "");
  }

  function setMode(next) {
    mode = next;
    if (!ui) return;
    ui.toggleEl.textContent = mode === "asl" ? "ASL" : "EN";
    // Re-render every existing line from its stashed strings — no refetch.
    for (const line of ui.listEl.querySelectorAll(".line")) {
      const txt = line.querySelector(".txt");
      const gloss = line.dataset.gloss || "";
      const en = line.dataset.en || "";
      txt.textContent = mode === "asl" && gloss ? gloss : en;
    }
  }

  function makeDraggable(host, handle) {
    let dx = 0, dy = 0, dragging = false;
    handle.addEventListener("mousedown", (e) => {
      dragging = true;
      const rect = host.getBoundingClientRect();
      dx = e.clientX - rect.left;
      dy = e.clientY - rect.top;
      host.style.right = "auto";
      e.preventDefault();
    });
    window.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      host.style.left = `${e.clientX - dx}px`;
      host.style.top = `${e.clientY - dy}px`;
    });
    window.addEventListener("mouseup", () => (dragging = false));
  }

  function addLine(chunk, cached) {
    const { listEl } = ensureOverlay();
    if (ui.empty) {
      listEl.innerHTML = "";
      ui.empty = false;
    }
    const line = document.createElement("div");
    line.className = "line" + (cached ? " cached" : "");
    line.dataset.time = String(chunk.video_time_offset || 0);
    // Stash both strings so the toggle can swap text with no refetch.
    line.dataset.en = chunk.text || "";
    line.dataset.gloss = Array.isArray(chunk.gloss) ? chunk.gloss.join(" ") : "";

    const t = document.createElement("span");
    t.className = "t";
    t.textContent = fmtTime(chunk.video_time_offset);
    const txt = document.createElement("span");
    txt.className = "txt";
    txt.textContent = lineText(chunk);

    line.append(t, txt);

    // Register the segment so the sign-clip panel can follow playback.
    registerSegment(chunk);
    // Click a caption to seek the video to it — the alignment payoff.
    line.addEventListener("click", () => {
      const v = getVideo();
      if (v) v.currentTime = Number(line.dataset.time) || 0;
    });

    // Keep the list ordered by video time.
    const rows = [...listEl.children];
    const at = rows.find((r) => Number(r.dataset.time) > (chunk.video_time_offset || 0));
    listEl.insertBefore(line, at || null);
    listEl.scrollTop = listEl.scrollHeight;
  }

  function updateLag() {
    if (!ui) return;
    const v = getVideo();
    const rows = [...ui.listEl.querySelectorAll(".line")];
    if (!v || rows.length === 0) {
      ui.lagEl.textContent = "";
      return;
    }
    const latest = Math.max(...rows.map((r) => Number(r.dataset.time) || 0));
    const lag = v.currentTime - latest;
    ui.lagEl.textContent = lag > 0 ? `~${Math.round(lag)}s behind` : "live";
  }

  // --- Sign-clip panel (auto-plays the active segment's clips) ------------
  let clipTimer = null;
  let activeSeg = null; // the segment whose clips are currently queued
  let clipIdx = 0;
  let clipQueueComplete = false;

  function registerSegment(chunk) {
    const clips = Array.isArray(chunk.clips) ? chunk.clips : [];
    const offset = Number(chunk.video_time_offset) || 0;
    // Keep segments sorted by offset; dedup by offset so cache+live don't double.
    if (segments.some((s) => s.offset === offset)) return;
    const end = Number(chunk.video_time_end) || offset + 10;
    const seg = { offset, end, clips };
    const at = segments.findIndex((s) => s.offset > offset);
    if (at === -1) segments.push(seg);
    else segments.splice(at, 0, seg);
  }

  // The segment to sign for the current video time: the one containing it, else
  // the most recent one at/just before it (covers the live trailing-lag case).
  function activeSegmentFor(t) {
    let candidate = null;
    for (const s of segments) {
      if (t >= s.offset && t < s.end) return s;
      if (s.offset <= t) candidate = s;
      else break;
    }
    return candidate;
  }

  function playSegment(seg) {
    activeSeg = seg;
    clipIdx = 0;
    clipQueueComplete = false;
    playNextClip();
  }

  function playNextClip() {
    if (!ui || !activeSeg) return;
    const clips = activeSeg.clips || [];
    if (clipIdx >= clips.length) {
      // Queue exhausted — hold until the active segment changes.
      clipQueueComplete = true;
      ui.clipLabel.textContent = clips.length ? "" : "—";
      if (!clips.length) {
        ui.clipVid.pause();
        ui.clipVid.removeAttribute("src");
        ui.clipVid.load();
      }
      return;
    }
    const clip = clips[clipIdx];
    clipIdx += 1;
    const vid = ui.clipVid;
    ui.clipLabel.textContent = `${clip.token} (${clipIdx}/${clips.length})`;

    vid.onloadedmetadata = () => {
      vid.onloadedmetadata = null;
      if (clip.target_duration > 0 && vid.duration > 0) {
        vid.playbackRate = Math.min(Math.max(vid.duration / clip.target_duration, 0.25), 4.0);
      } else {
        vid.playbackRate = 1.0;
      }
      vid.play().catch(() => {});
    };
    vid.src = clip.url;
  }

  function updateCurrentLine(t) {
    if (!ui) return;
    const seg = activeSegmentFor(t);
    let currentLine = null;
    for (const line of ui.listEl.querySelectorAll(".line")) {
      const active = seg !== null && Number(line.dataset.time) === seg.offset;
      line.classList.toggle("current", active);
      if (active) currentLine = line;
    }
    if (currentLine) currentLine.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  function driveClips() {
    if (!ui) return;
    const v = getVideo();
    ui.clipsEl.classList.toggle("on", segments.length > 0);
    if (!v) return;
    const t = v.currentTime;
    updateCurrentLine(t);
    // Mirror the page video's play/pause state.
    if (v.paused) {
      if (!ui.clipVid.paused) ui.clipVid.pause();
      return;
    }
    const seg = activeSegmentFor(t);
    if (seg && seg !== activeSeg) {
      playSegment(seg); // segment changed — restart its clip queue
    } else if (!clipQueueComplete && ui.clipVid.paused && ui.clipVid.src) {
      ui.clipVid.play().catch(() => {}); // resume after the page video un-paused
    }
  }

  // --- Polling -----------------------------------------------------------
  async function pollOnce() {
    if (!sessionId) return;
    try {
      const res = await fetch(`${BACKEND}/captions/${encodeURIComponent(sessionId)}`);
      if (!res.ok) return;
      const { chunks } = await res.json();
      for (const c of chunks) {
        if (c.status === "ready" && !seenChunks.has(c.chunk_index)) {
          seenChunks.add(c.chunk_index);
          addLine(c, false);
        }
      }
      updateLag();
    } catch (_) {
      // backend down; keep trying.
    }
  }

  async function loadCache() {
    if (!videoId) return;
    try {
      const res = await fetch(`${BACKEND}/captions/video/${encodeURIComponent(videoId)}`);
      if (!res.ok) return;
      const { chunks } = await res.json();
      for (const c of chunks) {
        // Don't double-render if this session already produced it.
        const key = `cache-${c.session_id}-${c.chunk_index}`;
        if (c.session_id === sessionId || seenChunks.has(key)) continue;
        seenChunks.add(key);
        addLine(c, true);
      }
    } catch (_) {}
  }

  function start(vid, sid) {
    videoId = vid;
    sessionId = sid;
    seenChunks.clear();
    segments.length = 0;
    activeSeg = null;
    clipIdx = 0;
    clipQueueComplete = false;
    ensureOverlay();
    setOverlayVisible(true);
    loadCache(); // instant history from prior sessions (cache-hit path)
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(pollOnce, POLL_MS);
    pollOnce();
    // Follow playback closely enough to switch clips on time (finer than POLL_MS).
    if (clipTimer) clearInterval(clipTimer);
    clipTimer = setInterval(driveClips, 400);
  }

  function stop() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
    if (clipTimer) clearInterval(clipTimer);
    clipTimer = null;
    if (ui && !ui.clipVid.paused) ui.clipVid.pause();
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === "GET_VIDEO_TIME") {
      const v = getVideo();
      sendResponse({ videoTime: v ? v.currentTime : 0 });
      return true;
    }
    if (msg.type === "CAPTIONS_START") {
      start(msg.videoId, msg.sessionId);
    }
    if (msg.type === "CAPTIONS_STOP") {
      stop();
    }
  });
}
