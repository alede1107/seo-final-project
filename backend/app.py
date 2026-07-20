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
import yt_dlp
import boto3
from botocore.exceptions import BotoCoreError, ClientError
from dotenv import load_dotenv
from flask import Flask, jsonify, make_response, request

import pipeline

load_dotenv()

app = Flask(__name__)

S3_BUCKET = os.environ.get("S3_BUCKET")
s3 = boto3.client("s3", region_name=os.environ.get("AWS_REGION", "us-east-1"))

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
def preflight(_any=None):
    return make_response("", 204)


def _validate(value: str, field: str) -> str:
    """Reject anything that could smuggle path tricks into an S3 key."""
    if not value or not SAFE_ID.match(value):
        raise ValueError(f"invalid {field}")
    return value


@app.route("/health", methods=["GET"])
def health():
    return jsonify({"ok": True})


@app.route("/upload", methods=["POST"])
def upload():
    if S3_BUCKET is None:
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
    Returns (path, ext, tmpdir). The caller must delete tmpdir when done (the
    local file is only needed until the S3 put; AssemblyAI pulls from S3 after).
    Raises on failure (caller maps to 502)."""
    

    tmpdir = tempfile.mkdtemp(prefix="captionaid-")
    outtmpl = os.path.join(tmpdir, "%(id)s.%(ext)s")
    opts = {
        "format": "bestaudio/best",
        "outtmpl": outtmpl,
        "quiet": True,
        "noplaylist": True,
        "postprocessors": [
            {"key": "FFmpegExtractAudio", "preferredcodec": "m4a"},
        ],
    }
    url = f"https://www.youtube.com/watch?v={video_id}"
    with yt_dlp.YoutubeDL(opts) as ydl:
        ydl.extract_info(url, download=True)
    # The postprocessor rewrites the extension to m4a.
    path = os.path.join(tmpdir, f"{video_id}.m4a")
    return path, "m4a", tmpdir


@app.route("/prepare", methods=["POST"])
def prepare():
    """Kick off whole-video transcription so captions are ready before playback.
    Downloads the audio (yt-dlp), stores the source in S3, and hands a pre-signed
    URL to the pipeline. Idempotent: a ready video returns immediately."""
    if S3_BUCKET is None:
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

    tmpdir = None
    try:
        path, ext, tmpdir = _download_audio(video_id)
        key = f"{video_id}/source-audio.{ext}"
        with open(path, "rb") as f:
            s3.put_object(Bucket=S3_BUCKET, Key=key, Body=f, ContentType="audio/mp4")
        audio_url = s3.generate_presigned_url(
            "get_object", Params={"Bucket": S3_BUCKET, "Key": key}, ExpiresIn=3600
        )
    except (BotoCoreError, ClientError) as e:
        app.logger.error("S3 source upload failed: %s", e)
        return jsonify({"error": "s3 upload failed"}), 502
    except Exception as e:  # noqa: BLE001 — yt-dlp/ffmpeg failures
        app.logger.error("audio download failed: %s", e)
        return jsonify({"error": "audio download failed"}), 502
    
    finally:
        if tmpdir is not None:
            shutil.rmtree(tmpdir, ignore_errors=True)

    pipeline.prepare_async(video_id, audio_url)
    return jsonify({"status": "preparing"}), 202


@app.route("/prepare/<video_id>", methods=["GET"])
def prepare_status(video_id):
    return jsonify(pipeline.get_prepared(video_id))

# CAPTION READ 
@app.route("/captions/<session_id>/<int:chunk_index>", methods=["GET"])
def caption_chunk(session_id, chunk_index):
    chunk = pipeline.get_chunk(session_id, chunk_index)
    if chunk is None:
        return jsonify({"status": "unknown"}), 404
    return jsonify(chunk)


@app.route("/captions/<session_id>", methods=["GET"])
def caption_session(session_id):
    """All chunks for a session — what the content script polls."""
    return jsonify({"session_id": session_id, "chunks": pipeline.get_session(session_id)})


@app.route("/captions/video/<video_id>", methods=["GET"])
def caption_video(video_id):
    """Cache-hit path: every ready caption ever produced for this video."""
    return jsonify({"video_id": video_id, "chunks": pipeline.get_video(video_id)})


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5001, debug=True, threaded=True)
