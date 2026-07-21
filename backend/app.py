"""
CaptionAid backend.

S3 key layout:
    {video_id}/{session_id}/chunk-{index:05d}.webm

Env vars:
    AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION, S3_BUCKET
    ASSEMBLYAI_API_KEY   (optional - unset runs the pipeline in mock mode)
"""

import os
import re
import shutil
import tempfile
from pathlib import Path

import boto3
import yt_dlp
from botocore.exceptions import BotoCoreError, ClientError
from dotenv import load_dotenv
from flask import Flask, jsonify, make_response, request, send_from_directory

load_dotenv()

if __package__:
    from . import pipeline
else:  # Supports `python backend/app.py` in addition to `python -m backend.app`.
    import pipeline

from services.chunk_processor import load_word_map

app = Flask(__name__, static_folder=None)

S3_BUCKET = os.environ.get("S3_BUCKET", "").strip()
s3 = boto3.client("s3", region_name=os.environ.get("AWS_REGION", "us-east-1"))
FRONTEND_DIST = Path(__file__).resolve().parents[1] / "frontend" / "dist"

SAFE_ID = re.compile(r"^[A-Za-z0-9_\-]{1,64}$")

pipeline.init_db()


# TODO : Lock the origin down to the extension id before any public deployment.
@app.after_request
def add_cors(response):
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    response.headers["Access-Control-Allow-Headers"] = "Content-Type"
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
    return jsonify({"ok": True})


@app.route("/upload", methods=["POST"])
def upload():
    if not S3_BUCKET:
        return jsonify({"error": "server misconfigured: S3_BUCKET not set"}), 500

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

    # Range-aware dedup: if this chunk's video-time span is already captioned
    # by a prior session of this video, skip S3 + AssemblyAI entirely. The
    # overlay already shows the region via the /captions/video cache path.
    covered = pipeline.find_covering(video_id, session_id, video_time_offset, video_time_end)
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
    js_runtimes = {}
    for runtime, executable in (("deno", "deno"), ("node", "node"), ("quickjs", "qjs")):
        path = shutil.which(executable)
        if path:
            js_runtimes[runtime] = {"path": path}

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


def _audio_content_type(ext):
    return {
        "m4a": "audio/mp4",
        "mp4": "video/mp4",
        "ogg": "audio/ogg",
        "opus": "audio/ogg",
        "webm": "audio/webm",
    }.get(ext, "application/octet-stream")


@app.route("/prepare", methods=["POST"])
@app.route("/api/prepare", methods=["POST"])
def prepare():
    """Kick off whole-video transcription so captions are ready before playback.
    Downloads the audio (yt-dlp), stores the source in S3, and hands a pre-signed
    URL to the pipeline. Idempotent: a ready video returns immediately."""
    if not S3_BUCKET:
        return jsonify({"error": "server misconfigured: S3_BUCKET not set"}), 500

    body = request.get_json(silent=True) or {}
    try:
        video_id = _validate(body.get("video_id", ""), "video_id")
    except ValueError as e:
        return jsonify({"error": str(e)}), 400

    status = pipeline.get_prepared(video_id)
    if status["status"] == "ready":
        return jsonify({"status": "ready", "cached": True}), 200
    if status["status"] == "preparing":
        return jsonify({"status": "preparing"}), 202

    # Mock mode: skip the download + S3 entirely; the pipeline fabricates ready
    # segments so the whole prepare -> skip-capture path is testable offline.
    if not pipeline.ASSEMBLYAI_KEY:
        pipeline.prepare_async(video_id, None)
        return jsonify({"status": "preparing"}), 202

    # Persist this before downloading so a closed/reopened extension popup can
    # still see that preparation is active and will not launch a duplicate job.
    pipeline.mark_prepare_started(video_id)
    tmpdir = None
    try:
        path, ext, tmpdir, metadata = _download_audio(video_id)
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
        pipeline.mark_prepare_error(video_id, "S3 source upload failed")
        return jsonify({"error": "s3 upload failed"}), 502
    except Exception as e:  # noqa: BLE001 - yt-dlp exposes several error types.
        app.logger.error("audio download failed: %s", e)
        detail = re.sub(r"\s+", " ", str(e)).strip()
        error = f"YouTube audio download failed: {detail}"
        pipeline.mark_prepare_error(video_id, error)
        return jsonify({"error": error}), 502

    finally:
        if tmpdir is not None:
            shutil.rmtree(tmpdir, ignore_errors=True)

    pipeline.prepare_async(video_id, audio_url)
    return jsonify({"status": "preparing"}), 202


@app.route("/prepare/<video_id>", methods=["GET"])
@app.route("/api/prepare/<video_id>", methods=["GET"])
def prepare_status(video_id):
    return jsonify(pipeline.get_prepared(video_id))

# CAPTION READ 
@app.route("/captions/<session_id>/<int:chunk_index>", methods=["GET"])
@app.route("/api/captions/<session_id>/<int:chunk_index>", methods=["GET"])
def caption_chunk(session_id, chunk_index):
    chunk = pipeline.get_chunk(session_id, chunk_index)
    if chunk is None:
        return jsonify({"status": "unknown"}), 404
    return jsonify(chunk)


@app.route("/captions/<session_id>", methods=["GET"])
@app.route("/api/captions/<session_id>", methods=["GET"])
def caption_session(session_id):
    """All chunks for a session — what the content script polls."""
    return jsonify({"session_id": session_id, "chunks": pipeline.get_session(session_id)})


@app.route("/captions/video/<video_id>", methods=["GET"])
@app.route("/api/captions/video/<video_id>", methods=["GET"])
def caption_video(video_id):
    """Cache-hit path: every ready caption ever produced for this video."""
    return jsonify({"video_id": video_id, "chunks": pipeline.get_video(video_id)})


@app.route("/api/sessions", methods=["GET"])
def sessions():
    try:
        limit = int(request.args.get("limit", "30"))
    except ValueError:
        return jsonify({"error": "limit must be an integer"}), 400
    items = pipeline.list_prepared(limit=limit)
    return jsonify({"items": items, "count": len(items)})


@app.route("/api", methods=["GET"])
def api_index():
    return jsonify(
        {
            "ok": True,
            "service": "CaptionAid API",
            "resources": ["prepare", "captions", "sessions", "signs", "feedback"],
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


@app.route("/api/feedback", methods=["POST"])
def feedback():
    body = request.get_json(silent=True) or {}
    message = str(body.get("message", "")).strip()
    if len(message) < 3:
        return jsonify({"error": "feedback must be at least 3 characters"}), 400
    if len(message) > 4000:
        return jsonify({"error": "feedback must be 4000 characters or fewer"}), 400
    feedback_id = pipeline.save_feedback(message)
    return jsonify({"ok": True, "id": feedback_id}), 201


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


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5001, debug=True, threaded=True)
