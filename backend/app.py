"""
CaptionAid backend.

S3 key layout:
    {video_id}/{session_id}/chunk-{index:05d}.webm

Env vars:
    AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION, S3_BUCKET
    CAPTION_AWS_ACCESS_KEY_ID, CAPTION_AWS_SECRET_ACCESS_KEY (Vercel aliases)
    ASSEMBLYAI_API_KEY   (optional - unset runs the pipeline in mock mode)
"""

import math
import os
import re
import shutil
import tempfile
from pathlib import Path

import boto3
import requests
import yt_dlp
from botocore.exceptions import BotoCoreError, ClientError
from dotenv import load_dotenv
from flask import Flask, jsonify, make_response, request, send_from_directory

PROJECT_ROOT = Path(__file__).resolve().parents[1]

# The repository-level .env is the single source of truth for local runs. Using
# an explicit path makes startup independent of the terminal's current folder.
load_dotenv(PROJECT_ROOT / ".env", override=True)

for env_key in (
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "CAPTION_AWS_ACCESS_KEY_ID",
    "CAPTION_AWS_SECRET_ACCESS_KEY",
    "AWS_REGION",
    "S3_BUCKET",
    "ASSEMBLYAI_API_KEY",
    "HF_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
):
    if env_key in os.environ:
        os.environ[env_key] = os.environ[env_key].strip()


def _first_env(*keys):
    for key in keys:
        value = os.environ.get(key, "").strip()
        if value:
            return value
    return ""


if __package__:
    from . import pipeline
else:  # Supports `python backend/app.py` in addition to `python -m backend.app`.
    import pipeline

from backend.cloud_prepared import S3PreparedStore
from services.chunk_processor import load_word_map

app = Flask(__name__, static_folder=None)

S3_BUCKET = os.environ.get("S3_BUCKET", "").strip()
AWS_ACCESS_KEY = _first_env("CAPTION_AWS_ACCESS_KEY_ID", "AWS_ACCESS_KEY_ID")
AWS_SECRET_KEY = _first_env("CAPTION_AWS_SECRET_ACCESS_KEY", "AWS_SECRET_ACCESS_KEY")
s3 = boto3.client(
    "s3",
    region_name=os.environ.get("AWS_REGION", "us-east-1"),
    aws_access_key_id=AWS_ACCESS_KEY or None,
    aws_secret_access_key=AWS_SECRET_KEY or None,
)
FRONTEND_DIST = PROJECT_ROOT / "frontend" / "dist"

CLOUD_STORE_ENABLED = (
    os.environ.get("CAPTION_STORE", "").strip().lower() == "s3"
    or bool(os.environ.get("VERCEL"))
)
cloud_store = None
if CLOUD_STORE_ENABLED and S3_BUCKET and pipeline.ASSEMBLYAI_KEY:
    try:
        cloud_batch_size = int(os.environ.get("CAPTION_MATCH_BATCH_SIZE", "4"))
    except ValueError:
        cloud_batch_size = 4
    cloud_store = S3PreparedStore(
        s3,
        S3_BUCKET,
        pipeline.ASSEMBLYAI_KEY,
        pipeline._segment_words,
        lambda text, words, duration: pipeline._gloss_and_clips(
            text, words=words, chunk_duration=duration
        ),
        prefix=os.environ.get("CAPTION_STORE_PREFIX", "captionaid/v2"),
        batch_size=cloud_batch_size,
    )

SAFE_ID = re.compile(r"^[A-Za-z0-9_\-]{1,64}$")

pipeline.init_db()


@app.after_request
def add_cors(response):
    # Local development must support unpacked Chrome and Edge extensions,
    # whose generated IDs differ on every teammate's machine.
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, DELETE, OPTIONS"
    response.headers["Access-Control-Allow-Headers"] = "Content-Type"
    if request.path.startswith("/assets/"):
        response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
    return response


@app.route("/upload", methods=["OPTIONS"])
@app.route("/prepare", methods=["OPTIONS"])
@app.route("/prepare/<path:_any>", methods=["OPTIONS"])
@app.route("/captions/<path:_any>", methods=["OPTIONS"])
@app.route("/api", methods=["OPTIONS"])
@app.route("/api/<path:_any>", methods=["OPTIONS"])
def preflight(_any=None):
    return make_response("", 204)


def _validate(value: str, field: str) -> str:
    """Reject anything that could smuggle path tricks into an S3 key."""
    if not value or not SAFE_ID.match(value):
        raise ValueError(f"invalid {field}")
    return value


@app.route("/health", methods=["GET"])
@app.route("/api/health", methods=["GET"])
def health():
    if CLOUD_STORE_ENABLED:
        missing = []
        if not AWS_ACCESS_KEY:
            missing.append("CAPTION_AWS_ACCESS_KEY_ID")
        if not AWS_SECRET_KEY:
            missing.append("CAPTION_AWS_SECRET_ACCESS_KEY")
        for key in ("S3_BUCKET", "ASSEMBLYAI_API_KEY"):
            if not os.environ.get(key, "").strip():
                missing.append(key)
        if missing:
            return jsonify({"ok": False, "missing": missing}), 503
        try:
            s3.head_bucket(Bucket=S3_BUCKET)
        except (BotoCoreError, ClientError) as e:
            app.logger.error("S3 health check failed: %s", e)
            return jsonify(
                {
                    "ok": False,
                    "error": "S3 credentials or bucket access are invalid",
                }
            ), 503
    return jsonify({"ok": True})


def _get_prepared(video_id, *, advance=False):
    if cloud_store is not None:
        status = cloud_store.get_prepared(video_id, advance=False)
        if status.get("source") == "extension":
            # Extension chunks are advanced through /captions/<session_id>, not
            # through the legacy whole-video preparation poller.
            return status
        return cloud_store.get_prepared(video_id, advance=advance)
    return pipeline.get_prepared(video_id)


def _mark_prepare_started(video_id):
    if cloud_store is not None:
        cloud_store.start(video_id)
    else:
        pipeline.mark_prepare_started(video_id)


def _mark_prepare_error(video_id, error):
    if cloud_store is not None:
        cloud_store.mark_error(video_id, error)
    else:
        pipeline.mark_prepare_error(video_id, error)


@app.route("/upload", methods=["POST"])
def upload():
    if not S3_BUCKET:
        return jsonify({"error": "server misconfigured: S3_BUCKET not set"}), 500
    if CLOUD_STORE_ENABLED and cloud_store is None:
        return jsonify(
            {"error": "server misconfigured: cloud caption store credentials are incomplete"}
        ), 500

    audio = request.files.get("audio")
    if audio is None:
        return jsonify({"error": "missing audio file"}), 400

    try:
        video_id = _validate(request.form.get("video_id", ""), "video_id")
        session_id = _validate(request.form.get("session_id", ""), "session_id")
        chunk_index = int(request.form.get("chunk_index", "-1"))
        if chunk_index < 0:
            raise ValueError("invalid chunk_index")
        video_time_offset = float(request.form.get("video_time_offset", "0"))
        video_time_end = float(request.form.get("video_time_end", "0"))
    except ValueError as e:
        return jsonify({"error": str(e)}), 400

    video_title = request.form.get("video_title", "").strip()[:300] or None

    if cloud_store is not None:
        try:
            existing = cloud_store.get_live_chunk(session_id, chunk_index)
            if existing and existing.get("status") in {"pending", "ready", "empty"}:
                return jsonify({"ok": True, "cached": True}), 200
            covered = cloud_store.find_covering(
                video_id,
                session_id,
                video_time_offset,
                video_time_end,
            )
        except (BotoCoreError, ClientError) as e:
            app.logger.error("caption store read failed: %s", e)
            return jsonify({"error": "caption store unavailable"}), 503
    else:
        covered = pipeline.find_covering(
            video_id,
            session_id,
            video_time_offset,
            video_time_end,
        )

    # Range-aware dedup: if this chunk's video-time span is already captioned
    # by a prior session of this video, skip S3 + AssemblyAI entirely. The
    # overlay already shows the region via the /captions/video cache path.
    if covered is not None:
        return (
            jsonify(
                {
                    "ok": True,
                    "cached": True,
                    "covered_by": {
                        "session_id": covered["session_id"],
                        "chunk_index": covered["chunk_index"],
                    },
                }
            ),
            200,
        )

    key = f"{video_id}/{session_id}/chunk-{chunk_index:05d}.webm"

    # Read bytes once so we can both store them and hand a URL to AssemblyAI.
    data = audio.read()
    try:
        s3.put_object(
            Bucket=S3_BUCKET,
            Key=key,
            Body=data,
            ContentType="audio/webm",
            Metadata={"captured-at": request.form.get("captured_at", "")},
        )
        # Pre-signed GET URL so AssemblyAI pulls the chunk straight from S3
        # instead of us re-uploading the bytes.
        audio_url = s3.generate_presigned_url(
            "get_object", Params={"Bucket": S3_BUCKET, "Key": key}, ExpiresIn=3600
        )
    except (BotoCoreError, ClientError) as e:
        app.logger.error("S3 upload failed: %s", e)
        return jsonify({"error": "s3 upload failed"}), 502

    if cloud_store is not None:
        try:
            cloud_store.submit_live_chunk(
                video_id,
                session_id,
                chunk_index,
                audio_url,
                video_time_offset=video_time_offset,
                video_time_end=video_time_end,
                source_key=key,
                title=video_title,
            )
        except Exception as e:  # noqa: BLE001 - upstream HTTP errors vary.
            app.logger.error("AssemblyAI chunk submission failed: %s", e)
            return jsonify({"error": "AssemblyAI submission failed"}), 502
        return jsonify({"ok": True, "key": key, "status": "pending"}), 201

    pipeline.insert_pending(video_id, session_id, chunk_index, video_time_offset, video_time_end)
    pipeline.transcribe_async(audio_url, video_id, session_id, chunk_index)

    return jsonify({"ok": True, "key": key}), 201


def _download_audio(video_id):
    """Download bestaudio for a YouTube video_id to a temp file via yt-dlp.
    Returns (path, ext, tmpdir, metadata). The caller must delete tmpdir when
    done (the local file is only needed until the S3 put; AssemblyAI pulls from
    S3 after). Raises on failure (caller maps to 502)."""
    tmpdir = tempfile.mkdtemp(prefix="captionaid-")
    outtmpl = os.path.join(tmpdir, "%(id)s.%(ext)s")
    js_runtimes = _youtube_js_runtimes()

    if not js_runtimes:
        shutil.rmtree(tmpdir, ignore_errors=True)
        raise RuntimeError(
            "No supported JavaScript runtime found. Install Node.js 22+ or Deno 2.3+ "
            "and make sure it is available on PATH."
        )

    opts = {
        "format": "bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio/best[ext=mp4]/best",
        "outtmpl": outtmpl,
        "quiet": True,
        "noplaylist": True,
        "check_formats": "selected",
        "extractor_retries": 3,
        "fragment_retries": 3,
        "retries": 3,
        "socket_timeout": 30,
        "js_runtimes": js_runtimes,
        "extractor_args": {"youtube": {"player_client": ["android_vr"]}},
    }
    url = f"https://www.youtube.com/watch?v={video_id}"
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=True)
            downloads = info.get("requested_downloads") or []
            path = next((item.get("filepath") for item in downloads if item.get("filepath")), None)
            path = path or info.get("_filename") or ydl.prepare_filename(info)

        if not path or not os.path.isfile(path) or os.path.getsize(path) == 0:
            raise RuntimeError("yt-dlp completed without producing an audio file")

        ext = os.path.splitext(path)[1].lstrip(".").lower()
        if not ext or not re.fullmatch(r"[a-z0-9]+", ext):
            raise RuntimeError(f"yt-dlp produced an unsupported file extension: {ext!r}")
        metadata = {
            "title": info.get("title"),
            "duration": info.get("duration"),
        }
        return path, ext, tmpdir, metadata
    except Exception:
        shutil.rmtree(tmpdir, ignore_errors=True)
        raise


def _youtube_js_runtimes():
    runtimes = {}
    for runtime, executable in (("deno", "deno"), ("node", "node"), ("quickjs", "qjs")):
        path = shutil.which(executable)
        if path:
            runtimes[runtime] = {"path": path}
    return runtimes


def _english_caption_formats(info):
    """Return the best English YouTube caption format list, preferring manual captions."""
    for source_name in ("subtitles", "automatic_captions"):
        tracks = info.get(source_name) or {}
        language = next(
            (key for key in tracks if str(key).lower() == "en"),
            None,
        )
        if language is None:
            language = next(
                (key for key in tracks if str(key).lower().startswith("en-")),
                None,
            )
        if language is not None and tracks.get(language):
            return tracks[language], source_name
    return [], None


def _json3_caption_cues(payload):
    raw_cues = []
    for event in payload.get("events") or []:
        segments = event.get("segs")
        if not isinstance(segments, list) or not segments:
            continue
        try:
            start = round(float(event.get("tStartMs")) / 1000, 3)
        except (TypeError, ValueError):
            continue

        text = "".join(str(segment.get("utf8") or "") for segment in segments)
        text = re.sub(r"[\u200b\u200e\u200f]", "", text)
        text = re.sub(r"\s+", " ", text).strip()
        if not text:
            continue

        try:
            duration = round(float(event.get("dDurationMs")) / 1000, 3)
        except (TypeError, ValueError):
            duration = 0
        raw_cues.append({"start": start, "duration": duration, "text": text})

    cues = []
    for index, cue in enumerate(raw_cues):
        next_start = raw_cues[index + 1]["start"] if index + 1 < len(raw_cues) else None
        end = round(cue["start"] + cue["duration"], 3)
        if not math.isfinite(end) or end <= cue["start"]:
            end = next_start if next_start is not None and next_start > cue["start"] else cue["start"] + 2
        cues.append({"start": cue["start"], "end": end, "text": cue["text"]})
    return cues


def _download_youtube_captions(video_id):
    """Resolve and download an English timed-caption track without downloading media."""
    options = {
        "skip_download": True,
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "extractor_retries": 3,
        "retries": 3,
        "socket_timeout": 30,
        "extractor_args": {"youtube": {"player_client": ["android_vr"]}},
    }
    js_runtimes = _youtube_js_runtimes()
    if js_runtimes:
        options["js_runtimes"] = js_runtimes

    url = f"https://www.youtube.com/watch?v={video_id}"
    with yt_dlp.YoutubeDL(options) as ydl:
        info = ydl.extract_info(url, download=False)

    formats, source = _english_caption_formats(info)
    track = next((item for item in formats if item.get("ext") == "json3"), None)
    if track is None:
        return None

    response = requests.get(
        track["url"],
        headers=info.get("http_headers") or {},
        timeout=30,
    )
    response.raise_for_status()
    if not response.content.strip():
        raise RuntimeError("YouTube returned an empty caption track")

    cues = _json3_caption_cues(response.json())
    if not cues:
        raise RuntimeError("YouTube returned a caption track with no transcript text")

    duration = info.get("duration")
    try:
        duration = float(duration)
    except (TypeError, ValueError):
        duration = cues[-1]["end"]
    if not math.isfinite(duration) or duration <= 0:
        duration = cues[-1]["end"]

    return {
        "captions": cues,
        "title": re.sub(r"\s+", " ", str(info.get("title") or "")).strip()[:300] or None,
        "duration": max(duration, cues[-1]["end"]),
        "caption_source": source,
    }


def _audio_content_type(ext):
    return {
        "m4a": "audio/mp4",
        "mp4": "video/mp4",
        "ogg": "audio/ogg",
        "opus": "audio/ogg",
        "webm": "audio/webm",
    }.get(ext, "application/octet-stream")


def _caption_track_payload(body):
    raw_cues = body.get("captions")
    if not isinstance(raw_cues, list) or not raw_cues:
        raise ValueError("captions must be a non-empty list")
    if len(raw_cues) > 10_000:
        raise ValueError("caption track is too large")

    cues = []
    total_characters = 0
    for raw in raw_cues:
        if not isinstance(raw, dict):
            raise ValueError("each caption must be an object")
        try:
            start = float(raw.get("start"))
            end = float(raw.get("end"))
        except (TypeError, ValueError) as exc:
            raise ValueError("caption times must be numbers") from exc
        if not math.isfinite(start) or not math.isfinite(end) or start < 0 or end <= start:
            raise ValueError("caption times are invalid")

        text = re.sub(r"\s+", " ", str(raw.get("text") or "")).strip()
        if not text:
            continue
        total_characters += len(text)
        if total_characters > 1_000_000:
            raise ValueError("caption track text is too large")
        cues.append({"start": start, "end": end, "text": text})

    if not cues:
        raise ValueError("caption track contains no transcript text")

    segments = pipeline.segment_caption_cues(cues)
    if not segments:
        raise ValueError("caption track contains no usable segments")
    return segments


@app.route("/prepare", methods=["POST"])
@app.route("/api/prepare", methods=["POST"])
def prepare():
    """Prepare a complete video transcript, sign queue, and durable history job.

    YouTube's timed captions are preferred because they are faster and avoid a
    large media download. Videos without usable captions retain the existing
    audio-download and AssemblyAI transcription path.
    """
    body = request.get_json(silent=True) or {}
    try:
        video_id = _validate(body.get("video_id", ""), "video_id")
    except ValueError as e:
        return jsonify({"error": str(e)}), 400

    if CLOUD_STORE_ENABLED and cloud_store is None:
        return jsonify(
            {"error": "server misconfigured: cloud caption store credentials are incomplete"}
        ), 500

    try:
        status = _get_prepared(video_id)
    except (BotoCoreError, ClientError) as e:
        app.logger.error("caption store read failed: %s", e)
        return jsonify({"error": "caption store unavailable"}), 503
    live_only = status.get("source") == "extension"
    if status["status"] == "ready" and not live_only:
        return jsonify({"status": "ready", "cached": True}), 200
    if status["status"] == "preparing" and not live_only:
        return jsonify({"status": "preparing"}), 202

    # Mock mode: skip the download + S3 entirely; the pipeline fabricates ready
    # segments so the whole prepare -> skip-capture path is testable offline.
    if not pipeline.ASSEMBLYAI_KEY and not CLOUD_STORE_ENABLED:
        pipeline.prepare_async(video_id, None)
        return jsonify({"status": "preparing"}), 202

    try:
        caption_track = _download_youtube_captions(video_id)
    except Exception as exc:  # noqa: BLE001 - yt-dlp and timedtext errors vary.
        caption_track = None
        app.logger.warning(
            "YouTube caption track unavailable for %s; trying audio transcription: %s",
            video_id,
            exc,
        )

    if caption_track is not None:
        try:
            segments = _caption_track_payload(caption_track)
            if cloud_store is not None:
                prepared = cloud_store.submit_segments(
                    video_id,
                    segments,
                    title=caption_track.get("title"),
                    duration=caption_track.get("duration"),
                )
            else:
                pipeline.prepare_segments_async(
                    video_id,
                    segments,
                    title=caption_track.get("title"),
                    duration=caption_track.get("duration"),
                )
                prepared = {
                    "video_id": video_id,
                    "status": "preparing",
                    "stage": "matching_signs",
                    "progress": 65,
                    "source": "youtube_captions",
                }
            prepared["segment_count"] = len(segments)
            return jsonify(prepared), 202
        except (BotoCoreError, ClientError) as exc:
            app.logger.error("caption transcript store failed: %s", exc)
            return jsonify({"error": "caption store unavailable"}), 503

    if not S3_BUCKET:
        return jsonify({"error": "server misconfigured: S3_BUCKET not set"}), 500

    # Persist this before downloading so a closed/reopened extension popup can
    # still see that preparation is active and will not launch a duplicate job.
    try:
        _mark_prepare_started(video_id)
    except (BotoCoreError, ClientError) as e:
        app.logger.error("caption store write failed: %s", e)
        return jsonify({"error": "caption store unavailable"}), 503
    tmpdir = None
    metadata = {"title": None, "duration": None}
    key = None
    audio_url = None
    try:
        path, ext, tmpdir, metadata = _download_audio(video_id)
        if cloud_store is None:
            pipeline.set_prepare_metadata(
                video_id,
                title=metadata.get("title"),
                duration=metadata.get("duration"),
            )
        key = f"{video_id}/source-audio.{ext}"
        with open(path, "rb") as f:
            s3.put_object(
                Bucket=S3_BUCKET,
                Key=key,
                Body=f,
                ContentType=_audio_content_type(ext),
            )
        audio_url = s3.generate_presigned_url(
            "get_object", Params={"Bucket": S3_BUCKET, "Key": key}, ExpiresIn=3600
        )
    except (BotoCoreError, ClientError) as e:
        app.logger.error("S3 source upload failed: %s", e)
        _mark_prepare_error(video_id, "S3 source upload failed")
        return jsonify({"error": "s3 upload failed"}), 502
    except Exception as e:  # noqa: BLE001 - yt-dlp exposes several error types.
        app.logger.error("audio download failed: %s", e)
        detail = re.sub(r"\s+", " ", str(e)).strip()
        error = f"YouTube audio download failed: {detail}"
        _mark_prepare_error(video_id, error)
        return jsonify({"error": error}), 502

    finally:
        if tmpdir is not None:
            shutil.rmtree(tmpdir, ignore_errors=True)

    if cloud_store is not None:
        try:
            cloud_store.submit(
                video_id,
                audio_url,
                title=metadata.get("title"),
                duration=metadata.get("duration"),
                source_key=key,
            )
        except Exception as e:  # noqa: BLE001 - upstream HTTP errors vary.
            app.logger.error("AssemblyAI submission failed: %s", e)
            _mark_prepare_error(video_id, "AssemblyAI submission failed")
            return jsonify({"error": "AssemblyAI submission failed"}), 502
    else:
        pipeline.prepare_async(video_id, audio_url)
    return jsonify({"status": "preparing"}), 202


@app.route("/prepare/transcript", methods=["POST"])
@app.route("/api/prepare/transcript", methods=["POST"])
def prepare_transcript():
    """Prepare a complete timed transcript supplied by the browser extension."""
    body = request.get_json(silent=True) or {}
    try:
        video_id = _validate(body.get("video_id", ""), "video_id")
        segments = _caption_track_payload(body)
        title = re.sub(r"\s+", " ", str(body.get("title") or "")).strip()[:300] or None
        duration_value = body.get("duration")
        duration = float(duration_value) if duration_value is not None else segments[-1]["end"]
        if not math.isfinite(duration) or duration <= 0:
            duration = segments[-1]["end"]
        duration = max(duration, segments[-1]["end"])
    except (TypeError, ValueError) as exc:
        return jsonify({"error": str(exc)}), 400

    if CLOUD_STORE_ENABLED and cloud_store is None:
        return jsonify(
            {"error": "server misconfigured: cloud caption store credentials are incomplete"}
        ), 500

    try:
        if cloud_store is not None:
            status = cloud_store.submit_segments(
                video_id,
                segments,
                title=title,
                duration=duration,
            )
        else:
            pipeline.prepare_segments_async(
                video_id,
                segments,
                title=title,
                duration=duration,
            )
            status = {
                "video_id": video_id,
                "status": "preparing",
                "stage": "matching_signs",
                "progress": 65,
                "source": "youtube_captions",
            }
    except (BotoCoreError, ClientError) as exc:
        app.logger.error("caption transcript store failed: %s", exc)
        return jsonify({"error": "caption store unavailable"}), 503

    status["segment_count"] = len(segments)
    return jsonify(status), 202


@app.route("/prepare/<video_id>", methods=["GET"])
@app.route("/api/prepare/<video_id>", methods=["GET"])
def prepare_status(video_id):
    try:
        return jsonify(_get_prepared(video_id, advance=True))
    except (BotoCoreError, ClientError, requests.RequestException) as e:
        app.logger.error("preparation status failed: %s", e)
        return jsonify({"error": "preparation status is temporarily unavailable"}), 503

# CAPTION READ 
@app.route("/captions/<session_id>/<int:chunk_index>", methods=["GET"])
@app.route("/api/captions/<session_id>/<int:chunk_index>", methods=["GET"])
def caption_chunk(session_id, chunk_index):
    try:
        chunk = (
            cloud_store.get_live_chunk(session_id, chunk_index, advance=True)
            if cloud_store
            else pipeline.get_chunk(session_id, chunk_index)
        )
    except (BotoCoreError, ClientError, requests.RequestException) as e:
        app.logger.error("caption chunk read failed: %s", e)
        return jsonify({"error": "caption chunk unavailable"}), 503
    if chunk is None:
        return jsonify({"status": "unknown"}), 404
    return jsonify(chunk)


@app.route("/captions/<session_id>", methods=["GET"])
@app.route("/api/captions/<session_id>", methods=["GET"])
def caption_session(session_id):
    """All chunks for a session - what the content script polls."""
    try:
        chunks = (
            cloud_store.get_live_session(session_id, advance=True)
            if cloud_store
            else pipeline.get_session(session_id)
        )
    except (BotoCoreError, ClientError, requests.RequestException) as e:
        app.logger.error("caption session read failed: %s", e)
        return jsonify({"error": "caption session unavailable"}), 503
    return jsonify({"session_id": session_id, "chunks": chunks})


@app.route("/captions/video/<video_id>", methods=["GET"])
@app.route("/api/captions/video/<video_id>", methods=["GET"])
def caption_video(video_id):
    """Cache-hit path: every ready caption ever produced for this video."""
    try:
        chunks = (
            cloud_store.get_video(video_id)
            if cloud_store
            else pipeline.get_video(video_id)
        )
    except (BotoCoreError, ClientError) as e:
        app.logger.error("caption store read failed: %s", e)
        return jsonify({"error": "caption store unavailable"}), 503
    return jsonify({"video_id": video_id, "chunks": chunks})


@app.route("/api/sessions", methods=["GET"])
def sessions():
    try:
        limit = int(request.args.get("limit", "30"))
    except ValueError:
        return jsonify({"error": "limit must be an integer"}), 400
    try:
        items = (
            cloud_store.list_prepared(limit=limit)
            if cloud_store
            else pipeline.list_prepared(limit=limit)
        )
    except (BotoCoreError, ClientError) as e:
        app.logger.error("caption history read failed: %s", e)
        return jsonify({"error": "caption history unavailable"}), 503
    return jsonify({"items": items, "count": len(items)})


@app.route("/api/sessions/<video_id>", methods=["DELETE"])
def delete_session(video_id):
    try:
        safe_video_id = _validate(video_id, "video_id")
    except ValueError as e:
        return jsonify({"error": str(e)}), 400

    try:
        result = (
            cloud_store.delete_prepared(safe_video_id)
            if cloud_store
            else pipeline.delete_prepared(safe_video_id)
        )
    except (BotoCoreError, ClientError) as e:
        app.logger.error("caption delete failed: %s", e)
        return jsonify({"error": "caption store unavailable"}), 503
    if result.get("reason") == "not_found":
        return jsonify({"error": "prepared video not found"}), 404
    if result.get("reason") == "preparing":
        return jsonify({"error": "video is still preparing"}), 409

    return jsonify(
        {
            "ok": True,
            "video_id": safe_video_id,
            "captions_deleted": result["captions_deleted"],
        }
    )


@app.route("/api", methods=["GET"])
def api_index():
    return jsonify(
        {
            "ok": True,
            "service": "CaptionAid API",
            "resources": ["prepare", "captions", "sessions", "signs"],
        }
    )


def _sign_payload(word, url):
    return {
        "word": word.upper(),
        "url": url,
        "source": "WLASL vocabulary map",
    }


@app.route("/api/signs", methods=["GET"])
def signs():
    word_map = load_word_map()
    query = request.args.get("q", "").strip().lower()
    letter = request.args.get("letter", "").strip().lower()
    try:
        limit = max(1, min(int(request.args.get("limit", "60")), 250))
        offset = max(0, int(request.args.get("offset", "0")))
    except ValueError:
        return jsonify({"error": "limit and offset must be integers"}), 400

    words = sorted(word_map)
    if letter:
        if len(letter) != 1 or not letter.isalpha():
            return jsonify({"error": "letter must be one alphabetic character"}), 400
        words = [word for word in words if word.startswith(letter)]
    if query:
        words = [word for word in words if query in word]

    page = words[offset:offset + limit]
    return jsonify(
        {
            "items": [_sign_payload(word, word_map[word]) for word in page],
            "matched_total": len(words),
            "vocabulary_total": len(word_map),
            "limit": limit,
            "offset": offset,
        }
    )


@app.route("/api/signs/<path:word>", methods=["GET"])
def sign_detail(word):
    normalized = re.sub(r"[^a-z0-9']+", " ", word.lower()).strip()
    url = load_word_map().get(normalized)
    if not url:
        return jsonify({"error": "sign not found", "word": word}), 404
    return jsonify(_sign_payload(normalized, url))


@app.route("/api/<path:_missing>", methods=["GET", "POST", "PUT", "PATCH", "DELETE"])
def missing_api(_missing):
    return jsonify({"error": "API endpoint not found"}), 404


@app.route("/", defaults={"path": ""}, methods=["GET"])
@app.route("/<path:path>", methods=["GET"])
def companion_frontend(path):
    """Serve the built React companion site without affecting API routes."""
    if not FRONTEND_DIST.is_dir():
        return jsonify(
            {
                "ok": True,
                "service": "CaptionAid backend",
                "frontend": "not built",
                "hint": "Run npm install and npm run build in frontend/.",
            }
        )

    requested = (FRONTEND_DIST / path).resolve()
    try:
        requested.relative_to(FRONTEND_DIST.resolve())
    except ValueError:
        return jsonify({"error": "not found"}), 404

    if path and requested.is_file():
        return send_from_directory(FRONTEND_DIST, path)
    if path.startswith("assets/"):
        return jsonify({"error": "asset not found"}), 404
    return send_from_directory(FRONTEND_DIST, "index.html")


def run():
    """Run the local development server from either supported entrypoint."""
    app.run(host="127.0.0.1", port=5001, debug=True, threaded=True)


if __name__ == "__main__":
    run()
