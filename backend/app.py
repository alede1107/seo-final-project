"""
SignStream backend.
Receives WebM audio chunks from the Chrome extension and stores them in S3.

S3 key layout:
    {video_id}/{session_id}/chunk-{index:05d}.webm

Keyed by video_id first so that later, the transcription/cache layer can
look up everything ever captured for a given YouTube video.

Env vars required:
    AWS_ACCESS_KEY_ID
    AWS_SECRET_ACCESS_KEY
    AWS_REGION            (e.g. us-east-1)
    S3_BUCKET             (your bucket name)
"""

import os
import re
from dotenv import load_dotenv
import boto3
from botocore.exceptions import BotoCoreError, ClientError
from flask import Flask, jsonify, request, make_response

load_dotenv()
print(os.getenv('TEST'))

app = Flask(__name__)


@app.after_request
def add_cors(response):
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    response.headers["Access-Control-Allow-Headers"] = "Content-Type"
    return response


@app.route("/upload", methods=["OPTIONS"])
@app.route("/health", methods=["OPTIONS"])
def preflight():
    return make_response("", 204)

S3_BUCKET = os.environ.get("S3_BUCKET")

s3 = boto3.client(
    "s3",
    region_name=os.environ.get("AWS_REGION", "us-east-1"),
)

SAFE_ID = re.compile(r"^[A-Za-z0-9_\-]{1,64}$")


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
    except ValueError as e:
        return jsonify({"error": str(e)}), 400

    key = f"{video_id}/{session_id}/chunk-{chunk_index:05d}.webm"

    try:
        s3.upload_fileobj(
            audio,
            S3_BUCKET,
            key,
            ExtraArgs={
                "ContentType": "audio/webm",
                "Metadata": {
                    "captured-at": request.form.get("captured_at", ""),
                },
            },
        )
    except (BotoCoreError, ClientError) as e:
        app.logger.error("S3 upload failed: %s", e)
        return jsonify({"error": "s3 upload failed"}), 502

    return jsonify({"ok": True, "key": key}), 201


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5001, debug=True)
