from pathlib import Path
from werkzeug.utils import secure_filename
import os
import shutil
import subprocess
import tempfile


def save_upload(uploaded_file, upload_dir: Path):
    filename = secure_filename(uploaded_file.filename or "upload.mp4")
    target_path = upload_dir / filename
    uploaded_file.save(target_path)
    return target_path


def extract_audio_from_video(video_path: Path):
    source = Path(video_path)
    target = Path(tempfile.mkstemp(suffix=".wav")[1])

    ffmpeg = os.getenv("FFMPEG_BIN", "ffmpeg")
    if shutil.which(ffmpeg) is None:
        raise FileNotFoundError(
            f"ffmpeg was not found. Install ffmpeg and either add it to PATH or set FFMPEG_BIN to the full executable path. Current value: {ffmpeg}"
        )

    command = [
        ffmpeg,
        "-y",
        "-i",
        str(source),
        "-vn",
        "-acodec",
        "pcm_s16le",
        "-ar",
        "16000",
        "-ac",
        "1",
        str(target),
    ]

    completed = subprocess.run(command, capture_output=True, text=True)
    if completed.returncode != 0:
        raise RuntimeError(f"ffmpeg failed: {completed.stderr}")
    return str(target)
