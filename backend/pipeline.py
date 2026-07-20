"""
Transcription pipeline + caption store for Phase 2.

Flow:
    /upload writes the chunk to S3, then calls transcribe_async(...) which
    submits the chunk to AssemblyAI on a background thread. The result lands
    in a local SQLite table keyed (session_id, chunk_index). The extension's
    content script polls the /captions endpoints to read it back.

Why SQLite + a thread pool instead of Celery: this is a single-user vertical
slice. A thread pool is three lines and zero infrastructure. Swap in a real
queue only if concurrency actually hurts.

Time alignment:
    Each chunk carries `video_time_offset` — the video's currentTime (seconds)
    at the moment that chunk started recording. AssemblyAI returns word
    timestamps in ms from the start of the chunk, so:

        word_video_time = video_time_offset + (word.start / 1000)

    That maps every transcribed word to real video time, which is what lets
    the overlay stay aligned when the user pauses or rewinds.
"""

import json
import os
import queue
import sqlite3
import struct
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import urlencode
from pathlib import Path
import sys

parent_dir = Path(__file__).resolve().parent.parent
sys.path.append(str(parent_dir))

from services.chunk_processor import process_chunk

import requests
import websocket

DB_PATH = Path(__file__).resolve().parent / "captions.db"
ASSEMBLYAI_KEY = os.environ.get("ASSEMBLYAI_API_KEY")
AAI_BASE = "https://api.assemblyai.com/v2"

_conn = sqlite3.connect(DB_PATH, check_same_thread=False)
_conn.row_factory = sqlite3.Row
_lock = threading.Lock()

_executor = ThreadPoolExecutor(max_workers=4)
_live_sessions: dict[str, "LiveAssemblySession"] = {}
_live_sessions_lock = threading.Lock()


def init_db():
    with _lock:
        _conn.execute(
            """
            CREATE TABLE IF NOT EXISTS captions (
                video_id          TEXT NOT NULL,
                session_id        TEXT NOT NULL,
                chunk_index       INTEGER NOT NULL,
                status            TEXT NOT NULL,          -- pending | ready | error
                video_time_offset REAL NOT NULL DEFAULT 0,  -- live video time at chunk start (s)
                video_time_end    REAL NOT NULL DEFAULT 0,  -- live video time at chunk end (s)
                speaker_label     TEXT,
                text              TEXT,
                words_json        TEXT,                   -- [{text, start, end} ...] ms from chunk start
                error             TEXT,
                created_at        REAL NOT NULL,
                sign_matches      TEXT,
                sign_match        TEXT,
                PRIMARY KEY (session_id, chunk_index)
            )
            """
        )
        # Per-video pre-transcription job state (whole-video prepare path).
        # Distinct from `captions` (which stores the segments themselves) so the
        # popup can show progress and decide whether to skip live capture.
        _conn.execute(
            """
            CREATE TABLE IF NOT EXISTS prepared (
                video_id   TEXT PRIMARY KEY,
                status     TEXT NOT NULL,      -- preparing | ready | error
                error      TEXT,
                created_at REAL NOT NULL
            )
            """
        )
        # Migrate pre-existing DBs that lack video_time_end. Adding a column
        # that already exists raises OperationalError, which we swallow.
        try:
            _conn.execute("ALTER TABLE captions ADD COLUMN video_time_end REAL NOT NULL DEFAULT 0")
        except sqlite3.OperationalError:
            pass
        try:
            _conn.execute("ALTER TABLE captions ADD COLUMN speaker_label TEXT")
        except sqlite3.OperationalError:
            pass
        try:
            _conn.execute("ALTER TABLE captions ADD COLUMN sign_matches TEXT")
        except sqlite3.OperationalError:
            pass
        # Add sign_match result in the same place the caption belongs to
        try:
            _conn.execute("ALTER TABLE captions ADD COLUMN sign_match TEXT")
        except sqlite3.OperationalError:
            pass
        _conn.commit()


def _row_to_dict(row):
    return {
        "video_id": row["video_id"],
        "session_id": row["session_id"],
        "chunk_index": row["chunk_index"],
        "status": row["status"],
        "video_time_offset": row["video_time_offset"],
        "video_time_end": row["video_time_end"],
        "speaker_label": row["speaker_label"],
        "text": row["text"],
        "words": json.loads(row["words_json"]) if row["words_json"] else [],
        "error": row["error"],
        "sign_matches": json.loads(row["sign_matches"]) if row["sign_matches"] else [],
        "sign_match": json.loads(row["sign_match"]) if row["sign_match"] else None
    }


def insert_pending(video_id, session_id, chunk_index, video_time_offset, video_time_end=0):
    with _lock:
        _conn.execute(
            """
            INSERT OR REPLACE INTO captions
                (video_id, session_id, chunk_index, status, video_time_offset, video_time_end, created_at)
            VALUES (?, ?, ?, 'pending', ?, ?, ?)
            """,
            (video_id, session_id, chunk_index, video_time_offset, video_time_end, time.time()),
        )
        _conn.commit()


def insert_ready(
    video_id,
    session_id,
    chunk_index,
    video_time_offset,
    video_time_end,
    text,
    words,
    sign_match=None,
    speaker_label=None,
    sign_matches=None,
):
    """Insert an already-transcribed segment directly as `ready`. Used by the
    whole-video prepare path, where AssemblyAI returns all words up front so
    there is no pending stage."""
    with _lock:
        _conn.execute(
            """
            INSERT OR REPLACE INTO captions
                (video_id, session_id, chunk_index, status, video_time_offset,
                 video_time_end, speaker_label, text, words_json, sign_matches, sign_match, created_at)
            VALUES (?, ?, ?, 'ready', ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                video_id,
                session_id,
                chunk_index,
                video_time_offset,
                video_time_end,
                speaker_label,
                text,
                json.dumps(words),
                json.dumps(sign_matches) if sign_matches else None,
                json.dumps(sign_match) if sign_match else None,
                time.time(),
            ),
        )
        _conn.commit()


def _mark_ready(session_id, chunk_index, text, words, sign_match, speaker_label=None, sign_matches=None):
    with _lock:
        _conn.execute(
            "UPDATE captions SET status='ready', speaker_label=?, text=?, words_json=?, sign_matches=?, sign_match=? WHERE session_id=? AND chunk_index=?",
            (
                speaker_label,
                text,
                json.dumps(words),
                json.dumps(sign_matches) if sign_matches else None,
                json.dumps(sign_match) if sign_match else None,
                session_id,
                chunk_index,
            ),
        )
        _conn.commit()


def _mark_error(session_id, chunk_index, err):
    with _lock:
        _conn.execute(
            "UPDATE captions SET status='error', error=? WHERE session_id=? AND chunk_index=?",
            (str(err), session_id, chunk_index),
        )
        _conn.commit()


class LiveAssemblySession:
    """Manage one live AssemblyAI streaming session."""

    def __init__(self, video_id: str, session_id: str):
        self.video_id = video_id
        self.session_id = session_id
        self.turn_index = 0
        self.last_video_time_offset = 0.0
        self.last_video_time_end = 0.0
        self.latest_transcript = ""
        self.latest_speaker_label = None
        self.latest_sign_matches = []
        self.latest_sign_match = None
        self.audio_chunks_received = 0
        self.audio_bytes_received = 0
        self.audio_chunks_sent = 0
        self.audio_bytes_sent = 0
        self.latest_audio_peak = 0.0
        self.max_audio_peak = 0.0
        self.server_message_count = 0
        self.last_server_message_type = None
        self.assembly_session_id = None
        self.websocket_transport = None
        self.error = None
        self._audio_queue: "queue.Queue[bytes | None]" = queue.Queue()
        self._stop_event = threading.Event()
        self._ws = None
        self._ready = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def _run(self):
        if not ASSEMBLYAI_KEY:
            self.error = "ASSEMBLYAI_API_KEY missing"
            return

        params = {
            "sample_rate": 16000,
            "speech_model": "u3-rt-pro",
            "speaker_labels": "true",
            "format_turns": "true",
        }
        url = f"wss://streaming.assemblyai.com/v3/ws?{urlencode(params)}"
        try:
            if hasattr(websocket, "WebSocketApp"):
                self.websocket_transport = "WebSocketApp"
                self._run_with_websocket_app(url)
            else:
                self.websocket_transport = "WebSocket"
                self._run_with_raw_websocket(url)
        except Exception as exc:  # noqa: BLE001
            self.error = str(exc)
        finally:
            self._stop_event.set()

    def _handle_turn_message(self, message):
        try:
            data = json.loads(message)
        except Exception:
            return

        message_type = data.get("type")
        self.server_message_count += 1
        self.last_server_message_type = message_type
        if message_type == "Begin":
            self.assembly_session_id = data.get("id")

        if message_type != "Turn" or not data.get("end_of_turn"):
            if message_type == "Turn":
                self._update_live_preview(data)
            return

        self._update_live_preview(data)
        words = data.get("words") or []
        finalize_transcript_chunk(
            self.session_id,
            self.turn_index,
            text=data.get("transcript", ""),
            words=words,
            speaker_label=data.get("speaker_label"),
            video_id=self.video_id,
            video_time_offset=self.last_video_time_offset,
            video_time_end=self.last_video_time_end,
        )
        self.turn_index += 1

    def _update_live_preview(self, data):
        words = _words_from_turn(data.get("words") or [])
        transcript = data.get("transcript", "") or " ".join(word["text"] for word in words)
        speaker_label = data.get("speaker_label")
        if not transcript:
            return

        self.latest_transcript = transcript
        self.latest_speaker_label = speaker_label

        preview = {
            "speaker": speaker_label,
            "text": transcript,
            "is_final": True,
            "start": self.last_video_time_offset,
            "end": self.last_video_time_end,
        }
        sign_matches = process_chunk(preview)
        if not sign_matches:
            self.latest_sign_matches = []
            self.latest_sign_match = None
            return

        self.latest_sign_matches = sign_matches
        self.latest_sign_match = sign_matches[0]
        print("LIVE_PREVIEW_MATCH:", sign_matches)

    def _send_audio_loop(self, ws, binary_opcode=None):
        while not self._stop_event.is_set():
            try:
                item = self._audio_queue.get(timeout=0.1)
            except queue.Empty:
                continue
            if item is None:
                break
            try:
                if binary_opcode is None:
                    ws.send(item)
                else:
                    ws.send(item, binary_opcode)
                self.audio_chunks_sent += 1
                self.audio_bytes_sent += len(item)
            except Exception as exc:  # noqa: BLE001
                self.error = str(exc)
                break

        try:
            ws.send(json.dumps({"type": "Terminate"}))
        except Exception:
            pass

        try:
            ws.close()
        except Exception:
            pass

    def _run_with_websocket_app(self, url):
        def on_open(ws):
            self._ws = ws
            self._ready.set()
            threading.Thread(target=self._send_audio_loop, args=(ws, websocket.ABNF.OPCODE_BINARY), daemon=True).start()

        def on_message(_ws, message):
            self._handle_turn_message(message)

        def on_error(_ws, error):
            self.error = str(error)

        def on_close(_ws, _status_code, _msg):
            self._stop_event.set()

        ws_app = websocket.WebSocketApp(
            url,
            header={"Authorization": ASSEMBLYAI_KEY},
            on_open=on_open,
            on_message=on_message,
            on_error=on_error,
            on_close=on_close,
        )
        ws_app.run_forever()

    def _run_with_raw_websocket(self, url):
        ws = websocket.WebSocket()
        ws.connect(url, header=[f"Authorization: {ASSEMBLYAI_KEY}"])
        self._ws = ws
        self._ready.set()

        sender = threading.Thread(target=self._send_audio_loop, args=(ws, getattr(getattr(websocket, "ABNF", None), "OPCODE_BINARY", None)), daemon=True)
        sender.start()

        while not self._stop_event.is_set():
            try:
                message = ws.recv()
            except Exception as exc:  # noqa: BLE001
                self.error = str(exc)
                break
            if not message:
                continue
            self._handle_turn_message(message)

    def push_audio(self, audio_bytes: bytes, video_time_offset: float = 0.0, video_time_end: float = 0.0):
        self.last_video_time_offset = float(video_time_offset or 0.0)
        self.last_video_time_end = float(video_time_end or video_time_offset or 0.0)
        self.audio_chunks_received += 1
        self.audio_bytes_received += len(audio_bytes)
        even_length = len(audio_bytes) - (len(audio_bytes) % 2)
        if even_length:
            peak = max(abs(sample[0]) for sample in struct.iter_unpack("<h", audio_bytes[:even_length]))
            self.latest_audio_peak = round(peak / 32768.0, 4)
            self.max_audio_peak = max(self.max_audio_peak, self.latest_audio_peak)
        if self._stop_event.is_set():
            return
        self._ready.wait(timeout=5)
        self._audio_queue.put(audio_bytes)

    def stop(self):
        self._stop_event.set()
        self._audio_queue.put(None)

    def status(self):
        return {
            "video_id": self.video_id,
            "session_id": self.session_id,
            "status": "error" if self.error else ("streaming" if self._ready.is_set() else "starting"),
            "error": self.error,
            "turn_index": self.turn_index,
            "latest_transcript": self.latest_transcript,
            "latest_speaker_label": self.latest_speaker_label,
            "latest_sign_matches": self.latest_sign_matches,
            "latest_sign_match": self.latest_sign_match,
            "audio_chunks_received": self.audio_chunks_received,
            "audio_bytes_received": self.audio_bytes_received,
            "audio_chunks_sent": self.audio_chunks_sent,
            "audio_bytes_sent": self.audio_bytes_sent,
            "latest_audio_peak": self.latest_audio_peak,
            "max_audio_peak": self.max_audio_peak,
            "server_message_count": self.server_message_count,
            "last_server_message_type": self.last_server_message_type,
            "assembly_session_id": self.assembly_session_id,
            "websocket_transport": self.websocket_transport,
        }


def start_live_session(video_id: str, session_id: str):
    with _live_sessions_lock:
        if session_id in _live_sessions:
            return _live_sessions[session_id].status()
        session = LiveAssemblySession(video_id, session_id)
        _live_sessions[session_id] = session
        return session.status()


def push_live_audio(session_id: str, audio_bytes: bytes, video_time_offset: float = 0.0, video_time_end: float = 0.0):
    with _live_sessions_lock:
        session = _live_sessions.get(session_id)
    if session is None:
        raise KeyError(f"unknown live session: {session_id}")
    session.push_audio(audio_bytes, video_time_offset, video_time_end)


def stop_live_session(session_id: str):
    with _live_sessions_lock:
        session = _live_sessions.pop(session_id, None)
    if session is not None:
        session.stop()
    return {"ok": True}


def get_live_session(session_id: str):
    with _live_sessions_lock:
        session = _live_sessions.get(session_id)
    if session is None:
        return {"session_id": session_id, "status": "none", "error": None}
    return session.status()


def _words_from_turn(turn_words):
    words = []
    for word in turn_words or []:
        if not isinstance(word, dict):
            continue
        text = str(word.get("text", "")).strip()
        if not text:
            continue
        words.append(
            {
                "text": text,
                "start": int(word.get("start", 0) or 0),
                "end": int(word.get("end", 0) or 0),
            }
        )
    return words


def finalize_transcript_chunk(
    session_id,
    chunk_index,
    *,
    text,
    words,
    speaker_label=None,
    video_id=None,
    video_time_offset=0.0,
    video_time_end=0.0,
):
    """Shared end-of-turn / end-of-chunk processing.

    Both the batch upload path and the future live Turn adapter should feed
    finalized transcript text into this helper so sign matching stays identical
    regardless of how audio entered the pipeline.
    """
    normalized_words = _words_from_turn(words)
    start_s = normalized_words[0]["start"] / 1000.0 if normalized_words else float(video_time_offset or 0.0)
    end_s = normalized_words[-1]["end"] / 1000.0 if normalized_words else float(video_time_end or video_time_offset or 0.0)
    chunk = {
        "speaker": speaker_label,
        "text": text or "",
        "is_final": True,
        "start": start_s,
        "end": end_s,
    }

    sign_matches = process_chunk(chunk)
    sign_match = sign_matches[0] if sign_matches else None
    if sign_matches:
        print("SIGN_MATCHES: ", sign_matches)

    insert_ready(
        video_id or "",
        session_id,
        chunk_index,
        video_time_offset,
        video_time_end,
        text or "",
        normalized_words,
        sign_match,
        speaker_label=speaker_label,
        sign_matches=sign_matches,
    )
    return sign_matches


def finalize_turn_event(turn, session_id, chunk_index, *, video_id=None, video_time_offset=0.0, video_time_end=0.0):
    """Adapter for AssemblyAI streaming Turn events.

    Only finalized turns are processed. Partial turns are ignored so the same
    downstream logic can be shared with the batch upload path.
    """
    if not isinstance(turn, dict):
        return None
    if turn.get("type") != "Turn" or not turn.get("end_of_turn"):
        return None

    return finalize_transcript_chunk(
        session_id,
        chunk_index,
        text=turn.get("transcript", ""),
        words=turn.get("words") or [],
        speaker_label=turn.get("speaker_label"),
        video_id=video_id,
        video_time_offset=video_time_offset,
        video_time_end=video_time_end,
    )


def get_chunk(session_id, chunk_index):
    with _lock:
        row = _conn.execute(
            "SELECT * FROM captions WHERE session_id=? AND chunk_index=?",
            (session_id, chunk_index),
        ).fetchone()
    return _row_to_dict(row) if row else None


def get_session(session_id):
    with _lock:
        rows = _conn.execute(
            "SELECT * FROM captions WHERE session_id=? ORDER BY chunk_index",
            (session_id,),
        ).fetchall()
    return [_row_to_dict(r) for r in rows]


def get_video(video_id):
    """Cache-hit path: every ready caption ever produced for this video,
    across all sessions, ordered by video time."""
    with _lock:
        rows = _conn.execute(
            "SELECT * FROM captions WHERE video_id=? AND status='ready' ORDER BY video_time_offset",
            (video_id,),
        ).fetchall()
    return [_row_to_dict(r) for r in rows]


def find_covering(video_id, session_id, start, end, min_overlap=0.9):
    """Return a ready caption from a *different* session whose video-time span
    covers >= min_overlap of [start, end], else None.

    Used by /upload to skip re-uploading + re-transcribing a chunk whose video
    region was already captioned in a prior session. The current session is
    excluded so a backward seek within this session is re-transcribed rather
    than silently dropped (loadCache() in content.js doesn't render
    same-session rows)."""
    span = end - start
    if span <= 0:  # end unknown/seek-back within chunk: don't dedup
        return None
    with _lock:
        rows = _conn.execute(
            "SELECT * FROM captions WHERE video_id=? AND session_id!=? "
            "AND status='ready' ORDER BY video_time_offset",
            (video_id, session_id),
        ).fetchall()
    for r in rows:
        overlap = min(end, r["video_time_end"]) - max(start, r["video_time_offset"])
        if overlap > 0 and overlap / span >= min_overlap:
            return _row_to_dict(r)
    return None


# --- Whole-video prepare path ------------------------------------------
# Transcribe an entire video once, up front, and store the result as ready
# captions keyed by video_id (synthetic session `pre-<video_id>`). When a
# prepared video is opened the extension skips live capture and renders these
# straight from the /captions/video cache path.

def get_prepared(video_id):
    """Return {'video_id', 'status', 'error'} for a prepare job, or status
    'none' if the video has never been prepared."""
    with _lock:
        row = _conn.execute(
            "SELECT * FROM prepared WHERE video_id=?", (video_id,)
        ).fetchone()
    if row is None:
        return {"video_id": video_id, "status": "none", "error": None}
    return {"video_id": video_id, "status": row["status"], "error": row["error"]}


def _set_prepared(video_id, status, error=None):
    with _lock:
        _conn.execute(
            "INSERT OR REPLACE INTO prepared (video_id, status, error, created_at) "
            "VALUES (?, ?, ?, ?)",
            (video_id, status, error, time.time()),
        )
        _conn.commit()


def prepare_async(video_id, audio_url):
    """Mark the video as preparing and kick off whole-video transcription on the
    pool. `audio_url` is a pre-signed S3 GET URL for the downloaded source audio
    (None in mock mode)."""
    _set_prepared(video_id, "preparing")
    _executor.submit(_prepare, video_id, audio_url)


def _segment_words(words, seg_ms=10_000):
    """Bucket AssemblyAI words (start/end in ms from file start) into ~seg_ms
    segments. Yields (offset_s, end_s, text, bucket_words) matching the one-
    line-per-~10s display the overlay already renders."""
    segments = []
    bucket = []
    seg_start = 0
    for w in words:
        if bucket and w["start"] - seg_start >= seg_ms:
            segments.append(bucket)
            bucket = []
        if not bucket:
            seg_start = w["start"]
        bucket.append(w)
    if bucket:
        segments.append(bucket)

    out = []
    for b in segments:
        offset_s = b[0]["start"] / 1000.0
        end_s = b[-1]["end"] / 1000.0
        text = " ".join(w["text"] for w in b)
        out.append((offset_s, end_s, text, b))
    return out


def _prepare(video_id, audio_url):
    session_id = f"pre-{video_id}"
    try:
        if not ASSEMBLYAI_KEY:
            # Mock mode: three fake 10s segments so the prepare -> skip-capture
            # path is testable with no API key and no network.
            for idx in range(3):
                offset = idx * 10.0
                insert_ready(
                    video_id, session_id, idx, offset, offset + 10.0,
                    f"[mock prepared caption {idx}]",
                    [{"text": "[mock]", "start": 0, "end": 500}],
                    None,
                    None,
                )
            _set_prepared(video_id, "ready")
            return

        words = _transcribe_words(audio_url)
        for idx, (offset, end, text, bucket) in enumerate(_segment_words(words)):
            insert_ready(video_id, session_id, idx, offset, end, text, bucket, None, None)
        _set_prepared(video_id, "ready")
    except Exception as e:  # noqa: BLE001 — worker thread must never crash silently
        _set_prepared(video_id, "error", str(e))


def _transcribe_words(audio_url):
    """Submit a whole file to AssemblyAI and return its word list once complete.
    Shares the submit/poll shape with _transcribe but returns words instead of
    writing a single caption row."""
    headers = {"authorization": ASSEMBLYAI_KEY}
    submit = requests.post(
        f"{AAI_BASE}/transcript",
        headers=headers,
        json={"audio_url": audio_url, "punctuate": True, "format_text": True},
        timeout=30,
    )
    submit.raise_for_status()
    transcript_id = submit.json()["id"]

    while True:
        poll = requests.get(f"{AAI_BASE}/transcript/{transcript_id}", headers=headers, timeout=30)
        poll.raise_for_status()
        payload = poll.json()
        status = payload["status"]
        if status == "completed":
            return [
                {"text": w["text"], "start": w["start"], "end": w["end"]}
                for w in (payload.get("words") or [])
            ]
        if status == "error":
            raise RuntimeError(payload.get("error", "AssemblyAI error"))
        time.sleep(2)


def transcribe_async(audio_url, video_id, session_id, chunk_index):
    """Fire-and-forget: submit the chunk to AssemblyAI on the pool."""
    _executor.submit(_transcribe, audio_url, video_id, session_id, chunk_index)


def _transcribe(audio_url, video_id, session_id, chunk_index):
    try:
        if not ASSEMBLYAI_KEY:
            # Mock mode: lets you test the whole slice with no API key.
            time.sleep(1.0)
            finalize_transcript_chunk(
                session_id,
                chunk_index,
                text=f"[mock caption for chunk {chunk_index}]",
                words=[{"text": "[mock]", "start": 0, "end": 500}],
                speaker_label=None,
            )
            return

        headers = {"authorization": ASSEMBLYAI_KEY}
        submit = requests.post(
            f"{AAI_BASE}/transcript",
            headers=headers,
            json={"audio_url": audio_url, "punctuate": True, "format_text": True},
            timeout=30,
        )
        submit.raise_for_status()
        transcript_id = submit.json()["id"]

        while True:
            poll = requests.get(f"{AAI_BASE}/transcript/{transcript_id}", headers=headers, timeout=30)
            poll.raise_for_status()
            payload = poll.json()
            status = payload["status"]
            if status == "completed":
                words = [
                    {"text": w["text"], "start": w["start"], "end": w["end"]}
                    for w in (payload.get("words") or [])
                ]
                finalize_transcript_chunk(
                    session_id,
                    chunk_index,
                    text=payload.get("text", ""),
                    words=words,
                    speaker_label=payload.get("speaker_label"),
                    video_id=video_id,
                )
                return
            if status == "error":
                _mark_error(session_id, chunk_index, payload.get("error", "AssemblyAI error"))
                return
            time.sleep(2)
    except Exception as e:  # noqa: BLE001 — worker thread must never crash silently
        _mark_error(session_id, chunk_index, e)
