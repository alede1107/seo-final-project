"""
Transcription pipeline + caption store 

Flow:
    /upload writes the chunk to S3, then calls transcribe_async(...) which
    submits the chunk to AssemblyAI on a background thread. The result lands
    in a local SQLite table keyed (session_id, chunk_index). The extension's
    content script polls the /captions endpoints to read it back.

Time alignment:
    Each chunk carries `video_time_offset` - the video's currentTime (seconds)
    at the moment that chunk started recording. AssemblyAI returns word
    timestamps in ms from the start of the chunk, so:

        word_video_time = video_time_offset + (word.start / 1000)

TODO: Switch to Celery if concurrency becomes an issue
"""

import atexit
import json
import os
import sys
ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT_DIR)


import sqlite3
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import requests

from services.chunk_processor import match_gloss
from backend.text_to_gloss import to_gloss

DB_PATH = Path(
    os.environ.get("CAPTION_DB_PATH", Path(__file__).resolve().parent / "captions.db")
)
DB_PATH.parent.mkdir(parents=True, exist_ok=True)
ASSEMBLYAI_KEY = os.environ.get("ASSEMBLYAI_API_KEY")
AAI_BASE = "https://api.assemblyai.com/v2"
PREPARE_PIPELINE_VERSION = 2

_conn = sqlite3.connect(DB_PATH, check_same_thread=False)
_conn.row_factory = sqlite3.Row
_lock = threading.Lock()

_executor = ThreadPoolExecutor(max_workers=4)


def _close_db():
    try:
        _conn.close()
    except sqlite3.Error:
        pass


atexit.register(_close_db)


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
                text              TEXT,
                words_json        TEXT,                   -- [{text, start, end} ...] ms from chunk start
                gloss_json        TEXT,                   -- ASL gloss: ["TOKEN", ...]
                clips_json        TEXT,                   -- sign clips: [{token, url} ...]
                error             TEXT,
                created_at        REAL NOT NULL,
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
                video_id         TEXT PRIMARY KEY,
                status           TEXT NOT NULL,      -- preparing | ready | error
                error            TEXT,
                created_at       REAL NOT NULL,
                pipeline_version INTEGER NOT NULL DEFAULT 2,
                title            TEXT,
                duration         REAL
            )
            """
        )
        # Migrate pre-existing DBs that lack newer columns. Adding a column that
        # already exists raises OperationalError, which we swallow.
        for ddl in (
            "ALTER TABLE captions ADD COLUMN video_time_end REAL NOT NULL DEFAULT 0",
            "ALTER TABLE captions ADD COLUMN gloss_json TEXT",   # ASL gloss token array
            "ALTER TABLE captions ADD COLUMN clips_json TEXT",   # [{token, url} ...] sign clips
            "ALTER TABLE prepared ADD COLUMN pipeline_version INTEGER NOT NULL DEFAULT 1",
            "ALTER TABLE prepared ADD COLUMN title TEXT",
            "ALTER TABLE prepared ADD COLUMN duration REAL",
        ):
            try:
                _conn.execute(ddl)
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
        "text": row["text"],
        "words": json.loads(row["words_json"]) if row["words_json"] else [],
        "gloss": json.loads(row["gloss_json"]) if row["gloss_json"] else [],
        "clips": json.loads(row["clips_json"]) if row["clips_json"] else [],
        "error": row["error"],
    }


def _gloss_and_clips(text, words=None, chunk_duration=None):
    """
    Translate a caption's English text to ASL gloss and match sign clips

    Returns (gloss_tokens, clips). 
        At error or no match - Return ([], []) so
    a caption still stores its English text and words
    
    """
    try:
        gloss = to_gloss(text or "")
        clips = match_gloss(gloss, words=words, chunk_duration=chunk_duration)
        return gloss, clips
    except Exception:  # noqa: BLE001 — gloss is additive; never break the caption
        return [], []


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


def insert_ready(video_id, session_id, chunk_index, video_time_offset, video_time_end,
                 text, words, gloss=None, clips=None):
    """Insert an already-transcribed segment directly as `ready`. Used by the
    whole-video prepare path, where AssemblyAI returns all words up front so
    there is no pending stage. `gloss`/`clips` are the ASL translation + matched
    sign clips (empty lists if not provided)."""
    with _lock:
        _conn.execute(
            """
            INSERT OR REPLACE INTO captions
                (video_id, session_id, chunk_index, status, video_time_offset,
                 video_time_end, text, words_json, gloss_json, clips_json, created_at)
            VALUES (?, ?, ?, 'ready', ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                video_id, session_id, chunk_index, video_time_offset,
                video_time_end, text, json.dumps(words),
                json.dumps(gloss or []), json.dumps(clips or []), time.time(),
            ),
        )
        _conn.commit()


def _mark_ready(session_id, chunk_index, text, words):
    # Live path: translate to ASL gloss + match sign clips as the row becomes
    # ready, so the overlay gets gloss/clips alongside the English text.
    with _lock:
        row = _conn.execute(
            "SELECT video_time_offset, video_time_end FROM captions "
            "WHERE session_id=? AND chunk_index=?",
            (session_id, chunk_index),
        ).fetchone()
    chunk_duration = None

    # validate chunk duration for each row, incases where overall video length is <10s or last row is <10
    if row:
        d = (row["video_time_end"] or 0) - (row["video_time_offset"] or 0)
        if d > 0:
            chunk_duration = d
        else:
            chunk_duration = 10.0

    gloss, clips = _gloss_and_clips(text, words = words, chunk_duration=chunk_duration)

    with _lock:
        _conn.execute(
            "UPDATE captions SET status='ready', text=?, words_json=?, gloss_json=?, "
            "clips_json=? WHERE session_id=? AND chunk_index=?",
            (text, json.dumps(words), json.dumps(gloss), json.dumps(clips),
             session_id, chunk_index),
        )
        _conn.commit()


def _mark_error(session_id, chunk_index, err):
    with _lock:
        _conn.execute(
            "UPDATE captions SET status='error', error=? WHERE session_id=? AND chunk_index=?",
            (str(err), session_id, chunk_index),
        )
        _conn.commit()


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


# Transcribe an entire video once, up front, and store the result as ready
# captions keyed by video_id (synthetic session `pre-<video_id>`). 

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
    if row["pipeline_version"] != PREPARE_PIPELINE_VERSION:
        return {"video_id": video_id, "status": "none", "error": None, "stale": True}
    return {
        "video_id": video_id,
        "status": row["status"],
        "error": row["error"],
        "title": row["title"],
        "duration": row["duration"],
        "created_at": row["created_at"],
    }


def _set_prepared(video_id, status, error=None):
    with _lock:
        _conn.execute(
            """
            INSERT INTO prepared
                (video_id, status, error, created_at, pipeline_version)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(video_id) DO UPDATE SET
                status=excluded.status,
                error=excluded.error,
                created_at=excluded.created_at,
                pipeline_version=excluded.pipeline_version
            """,
            (video_id, status, error, time.time(), PREPARE_PIPELINE_VERSION),
        )
        _conn.commit()


def set_prepare_metadata(video_id, title=None, duration=None):
    """Attach display metadata discovered by yt-dlp without changing job state."""
    clean_title = str(title).strip()[:300] if title else None
    clean_duration = float(duration) if duration is not None else None
    with _lock:
        _conn.execute(
            "UPDATE prepared SET title=?, duration=? WHERE video_id=?",
            (clean_title, clean_duration, video_id),
        )
        _conn.commit()


def list_prepared(limit=50):
    """Return recent whole-video jobs with summary data for the companion site."""
    safe_limit = max(1, min(int(limit), 100))
    with _lock:
        jobs = _conn.execute(
            "SELECT * FROM prepared ORDER BY created_at DESC LIMIT ?",
            (safe_limit,),
        ).fetchall()

        results = []
        for job in jobs:
            rows = _conn.execute(
                "SELECT text, clips_json, video_time_end FROM captions "
                "WHERE video_id=? AND status='ready' ORDER BY video_time_offset",
                (job["video_id"],),
            ).fetchall()

            sign_count = 0
            for row in rows:
                try:
                    sign_count += len(json.loads(row["clips_json"] or "[]"))
                except (TypeError, json.JSONDecodeError):
                    pass

            transcript_preview = " ".join(
                row["text"].strip() for row in rows[:2] if row["text"]
            )[:240]
            caption_duration = max(
                (float(row["video_time_end"] or 0) for row in rows),
                default=0.0,
            )
            results.append(
                {
                    "video_id": job["video_id"],
                    "session_id": f"pre-{job['video_id']}",
                    "title": job["title"] or f"YouTube video {job['video_id']}",
                    "status": job["status"],
                    "error": job["error"],
                    "created_at": job["created_at"],
                    "duration": job["duration"] or caption_duration,
                    "chunk_count": len(rows),
                    "sign_count": sign_count,
                    "transcript_preview": transcript_preview,
                }
            )
    return results


def delete_prepared(video_id):
    """Delete one whole-video preparation without touching live sessions or S3."""
    session_id = f"pre-{video_id}"
    with _lock:
        job = _conn.execute(
            "SELECT status FROM prepared WHERE video_id=?", (video_id,)
        ).fetchone()
        if job is None:
            return {"deleted": False, "reason": "not_found"}
        if job["status"] == "preparing":
            return {"deleted": False, "reason": "preparing"}

        cursor = _conn.execute(
            "DELETE FROM captions WHERE video_id=? AND session_id=?",
            (video_id, session_id),
        )
        _conn.execute("DELETE FROM prepared WHERE video_id=?", (video_id,))
        _conn.commit()

    return {"deleted": True, "captions_deleted": cursor.rowcount}


def mark_prepare_started(video_id):
    _set_prepared(video_id, "preparing")


def mark_prepare_error(video_id, error):
    _set_prepared(video_id, "error", str(error))


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
        with _lock:
            _conn.execute("DELETE FROM captions WHERE session_id=?", (session_id,))
            _conn.commit()

        if not ASSEMBLYAI_KEY:
            # Mock mode: three fake 10s segments so the prepare -> skip-capture
            # path is testable with no API key and no network.
            for idx in range(3):
                offset = idx * 10.0
                text = f"the book is on the highway {idx}"
                mock_words = [{"text": "[mock]", "start": 0, "end": 500}]
                gloss, clips = _gloss_and_clips(text, words=mock_words, chunk_duration=10.0)
                insert_ready(
                    video_id, session_id, idx, offset, offset + 10.0,
                    text, mock_words, gloss, clips,
                )
            _set_prepared(video_id, "ready")
            return

        words = _transcribe_words(audio_url)
        if not words:
            raise RuntimeError("AssemblyAI completed but returned no transcript words")
        for idx, (offset, end, text, bucket) in enumerate(_segment_words(words)):
            gloss, clips = _gloss_and_clips(text, words=bucket, chunk_duration=end - offset)
            insert_ready(video_id, session_id, idx, offset, end, text, bucket, gloss, clips)
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
            _mark_ready(
                session_id,
                chunk_index,
                f"[mock caption for chunk {chunk_index}]",
                [{"text": "[mock]", "start": 0, "end": 500}],
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
                _mark_ready(session_id, chunk_index, payload.get("text", ""), words)
                return
            if status == "error":
                _mark_error(session_id, chunk_index, payload.get("error", "AssemblyAI error"))
                return
            time.sleep(2)
    except Exception as e:  # noqa: BLE001 — worker thread must never crash silently
        _mark_error(session_id, chunk_index, e)
