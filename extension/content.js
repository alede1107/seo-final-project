// content.js
// Runs on the YouTube page. Two jobs:
//   1. Report the <video> element's currentTime when the service worker asks
//      (used to align chunks to real video time).
//   2. Render a Shadow-DOM caption overlay, polling the backend for this
//      session's transcripts and (on start) any cached transcripts for the
//      video from previous sessions.
//
// Guard against double-init: the manifest declares this script AND the
// service worker may inject it programmatically into an already-open tab.
if (!window.__captionAidLoaded) {
  window.__captionAidLoaded = true;

  const BACKEND = "http://localhost:5001";
  const POLL_MS = 500;

  let pollTimer = null;
  let sessionId = null;
  let videoId = null;
  let overlayVisible = true;
  let signQueue = [];
  let signQueueIndex = 0;
  let signQueueAutoplay = true;
  let lastLiveSignKey = "";
  const seenChunks = new Set(); // chunk_index values already rendered
  let ui = null;

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
        .box { width: 420px; max-height: 420px; background: rgba(15,15,18,0.92);
               color: #f2f2f2; border: 1px solid #333; border-radius: 10px;
               font: 13px/1.45 system-ui, sans-serif; box-shadow: 0 8px 28px rgba(0,0,0,.5);
               display: flex; flex-direction: column; overflow: hidden; }
        .bar { display: flex; align-items: center; gap: 8px; padding: 8px 10px;
               background: #1d1d22; cursor: move; user-select: none; }
        .bar b { font-size: 12px; letter-spacing: .3px; }
        .lag { margin-left: auto; font-size: 11px; color: #ffcb6b; }
        .hideBtn { border: 0; background: #2a2a31; color: #d8d8df; border-radius: 6px; padding: 3px 8px; font-size: 11px; cursor: pointer; }
        .hideBtn:hover { background: #34343d; }
        .signWrap { padding: 8px 10px 10px; border-bottom: 1px solid #2b2b33; background: rgba(25,25,30,0.95); }
        .signHead { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
        .signHead b { font-size: 12px; letter-spacing: .3px; }
        .signBadge { margin-left: auto; font-size: 11px; color: #89d185; }
        .signVideo { width: 100%; aspect-ratio: 16 / 9; background: #111; border: 1px solid #34343d;
                     border-radius: 8px; object-fit: cover; display: none; }
        .signEmpty { padding: 16px 10px; border: 1px dashed #3b3b44; border-radius: 8px; color: #9a9aa5; text-align: center; }
        .list { padding: 6px 4px; overflow-y: auto; }
        .line { padding: 5px 8px; border-radius: 6px; cursor: pointer; display: flex; gap: 8px; align-items: flex-start; }
        .line:hover { background: #26262d; }
        .t { color: #7fbfff; flex: 0 0 44px; font-variant-numeric: tabular-nums; }
        .cached .t { color: #8a8a8a; }
        .txt { flex: 1; }
        .meta { margin-top: 3px; font-size: 11px; color: #9bd6ff; }
        .empty { padding: 10px; color: #999; }
      </style>
      <div class="box">
        <div class="bar" part="bar">
          <b>CaptionAid</b>
          <span class="lag" id="lag"></span>
          <button class="hideBtn" id="hide-btn" type="button">Hide</button>
        </div>
        <div class="signWrap">
          <div class="signHead">
            <b>Matched sign</b>
            <span class="signBadge" id="sign-badge"></span>
          </div>
          <video id="sign-video" class="signVideo" muted playsinline></video>
          <div id="sign-empty" class="signEmpty">No sign clip yet</div>
        </div>
        <div class="list" id="list"><div class="empty">Waiting for captions...</div></div>
      </div>`;

    const listEl = root.getElementById("list");
    const lagEl = root.getElementById("lag");
    const hideBtn = root.getElementById("hide-btn");
    const signVideoEl = root.getElementById("sign-video");
    const signEmptyEl = root.getElementById("sign-empty");
    const signBadgeEl = root.getElementById("sign-badge");
    makeDraggable(host, root.querySelector(".bar"));
    signVideoEl.addEventListener("ended", advanceSignClip);
    hideBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      setOverlayVisible(false);
    });

    ui = { host, root, listEl, lagEl, signVideoEl, signEmptyEl, signBadgeEl, hideBtn, empty: true };
    return ui;
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

  function setOverlayVisible(visible) {
    overlayVisible = visible;
    const overlay = ensureOverlay();
    overlay.host.style.display = visible ? "block" : "none";
    if (overlay.launcher) {
      overlay.launcher.style.display = visible ? "none" : "block";
    }
  }

  function ensureLauncher() {
    if (ui && ui.launcher) return ui.launcher;
    const launcher = document.createElement("button");
    launcher.type = "button";
    launcher.id = "captionaid-launcher";
    launcher.textContent = "CaptionAid";
    launcher.style.cssText =
      "position:fixed;right:24px;top:80px;z-index:2147483647;display:none;" +
      "background:#1d1d22;color:#f2f2f2;border:1px solid #333;border-radius:999px;" +
      "padding:8px 12px;font:12px/1.2 system-ui,sans-serif;cursor:pointer;box-shadow:0 8px 28px rgba(0,0,0,.35);";
    launcher.addEventListener("click", () => setOverlayVisible(true));
    document.documentElement.appendChild(launcher);
    if (ui) ui.launcher = launcher;
    return launcher;
  }

  function clearSignClip() {
    const { signVideoEl, signEmptyEl, signBadgeEl } = ensureOverlay();
    signQueue = [];
    signQueueIndex = 0;
    signQueueAutoplay = true;
    signVideoEl.pause();
    signVideoEl.removeAttribute("src");
    signVideoEl.load();
    signVideoEl.style.display = "none";
    signEmptyEl.style.display = "block";
    signBadgeEl.textContent = "";
  }

  function liveSignKey(matches) {
    return (Array.isArray(matches) ? matches : [])
      .map((m) => `${m.word || ""}|${m.clip_url || ""}|${m.start ?? ""}|${m.end ?? ""}`)
      .join("::");
  }

  async function updateSignClip(signMatches, autoplay = true) {
    const matches = Array.isArray(signMatches) ? signMatches.filter(Boolean) : (signMatches ? [signMatches] : []);
    const { signVideoEl, signEmptyEl, signBadgeEl } = ensureOverlay();
    signQueue = matches;
    signQueueIndex = 0;
    signQueueAutoplay = autoplay;

    if (!matches.length) {
      clearSignClip();
      return;
    }

    const current = signQueue[signQueueIndex];
    const total = signQueue.length;
    signBadgeEl.textContent = current.word ? `${signQueueIndex + 1}/${total} sign: ${current.word}` : `${signQueueIndex + 1}/${total}`;
    signEmptyEl.style.display = "none";
    signVideoEl.style.display = "block";
    if (signVideoEl.src !== current.clip_url) {
      signVideoEl.src = current.clip_url;
    }
    if (signQueueAutoplay) {
      try {
        await signVideoEl.play();
      } catch (_) {
        // Autoplay may be blocked; the clip is still visible and playable.
      }
    }
  }

  async function advanceSignClip() {
    if (!signQueueAutoplay) return;
    if (!signQueue.length) return;
    signQueueIndex += 1;
    if (signQueueIndex >= signQueue.length) {
      clearSignClip();
      return;
    }
    const current = signQueue[signQueueIndex];
    const { signVideoEl, signBadgeEl, signEmptyEl } = ensureOverlay();
    signBadgeEl.textContent = current.word ? `${signQueueIndex + 1}/${signQueue.length} sign: ${current.word}` : `${signQueueIndex + 1}/${signQueue.length}`;
    signEmptyEl.style.display = "none";
    signVideoEl.style.display = "block";
    if (signVideoEl.src !== current.clip_url) {
      signVideoEl.src = current.clip_url;
    }
    try {
      await signVideoEl.play();
    } catch (_) {}
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

    const t = document.createElement("span");
    t.className = "t";
    t.textContent = fmtTime(chunk.video_time_offset);
    const txt = document.createElement("span");
    txt.className = "txt";
    txt.textContent = chunk.text || "";

    const signMatches = chunk.sign_matches && chunk.sign_matches.length
      ? chunk.sign_matches
      : (chunk.sign_match ? [chunk.sign_match] : []);

    if (signMatches.length && signMatches[0].word) {
      const meta = document.createElement("span");
      meta.className = "meta";
      meta.textContent = signMatches.length > 1
        ? `sign: ${signMatches[0].word} +${signMatches.length - 1} more`
        : `sign: ${signMatches[0].word}`;
      txt.appendChild(meta);
    }

    line.append(t, txt);
    // Click a caption to seek the video to it - the alignment payoff.
    line.addEventListener("click", () => {
      const v = getVideo();
      if (v) v.currentTime = Number(line.dataset.time) || 0;
    });

    if (signMatches.length) {
      updateSignClip(signMatches, !cached);
    }

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

      const liveRes = await fetch(`${BACKEND}/stream/${encodeURIComponent(sessionId)}`);
      if (liveRes.ok) {
        const live = await liveRes.json();
        const liveMatches = live.latest_sign_matches || (live.latest_sign_match ? [live.latest_sign_match] : []);
        if (liveMatches.length) {
          const key = liveSignKey(liveMatches);
          if (key && key !== lastLiveSignKey) {
            lastLiveSignKey = key;
            await updateSignClip(liveMatches, true);
          }
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
    lastLiveSignKey = "";
    seenChunks.clear();
    ensureOverlay();
    ensureLauncher();
    setOverlayVisible(true);
    clearSignClip();
    loadCache(); // instant history from prior sessions (cache-hit path)
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(pollOnce, POLL_MS);
    pollOnce();
  }

  function stop() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
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
