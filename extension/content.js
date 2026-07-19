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
  const POLL_MS = 2000;

  let pollTimer = null;
  let sessionId = null;
  let videoId = null;
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
        .box { width: 360px; max-height: 320px; background: rgba(15,15,18,0.92);
               color: #f2f2f2; border: 1px solid #333; border-radius: 10px;
               font: 13px/1.45 system-ui, sans-serif; box-shadow: 0 8px 28px rgba(0,0,0,.5);
               display: flex; flex-direction: column; overflow: hidden; }
        .bar { display: flex; align-items: center; gap: 8px; padding: 8px 10px;
               background: #1d1d22; cursor: move; user-select: none; }
        .bar b { font-size: 12px; letter-spacing: .3px; }
        .lag { margin-left: auto; font-size: 11px; color: #ffcb6b; }
        .list { padding: 6px 4px; overflow-y: auto; }
        .line { padding: 5px 8px; border-radius: 6px; cursor: pointer; display: flex; gap: 8px; }
        .line:hover { background: #26262d; }
        .t { color: #7fbfff; flex: 0 0 44px; font-variant-numeric: tabular-nums; }
        .cached .t { color: #8a8a8a; }
        .txt { flex: 1; }
        .empty { padding: 10px; color: #999; }
      </style>
      <div class="box">
        <div class="bar" part="bar">
          <b>CaptionAid</b>
          <span class="lag" id="lag"></span>
        </div>
        <div class="list" id="list"><div class="empty">Waiting for captions…</div></div>
      </div>`;

    const listEl = root.getElementById("list");
    const lagEl = root.getElementById("lag");
    makeDraggable(host, root.querySelector(".bar"));

    ui = { host, root, listEl, lagEl, empty: true };
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

    line.append(t, txt);
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
    ensureOverlay();
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
