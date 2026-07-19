import os
from pathlib import Path

from flask import Flask, jsonify, render_template, request, send_from_directory, send_file
from flask_cors import CORS
from dotenv import load_dotenv

from models import Audio, TranscriptSegment, db
from services.captions import generate_captions, segments_to_srt, segments_to_vtt
from services.media import extract_audio_from_video, save_upload


BASE_DIR = Path(__file__).resolve().parent
UPLOAD_DIR = BASE_DIR / "uploads"
UPLOAD_DIR.mkdir(exist_ok=True)

load_dotenv(BASE_DIR / ".env")


def create_app():
    app = Flask(__name__)
    app.config["SQLALCHEMY_DATABASE_URI"] = os.getenv("DATABASE_URL", f"sqlite:///{BASE_DIR / 'app.db'}")
    app.config["SQLALCHEMY_TRACK_MODIFICATIONS"] = False
    app.config["MAX_CONTENT_LENGTH"] = int(os.getenv("MAX_CONTENT_LENGTH", 500 * 1024 * 1024))

    CORS(app)
    db.init_app(app)

    with app.app_context():
        db.create_all()

    @app.get("/")
    def index():
        return render_template("index.html")

    @app.get("/health")
    def health():
        return jsonify({"ok": True})

    @app.get("/uploads/<path:filename>")
    def uploaded_file(filename: str):
        return send_from_directory(UPLOAD_DIR, filename)

    @app.post("/api/upload")
    def upload_media():
        media_file = request.files.get("file")

        if not media_file:
            return jsonify({"error": "Provide a video file upload."}), 400

        saved_path = save_upload(media_file, UPLOAD_DIR)
        audio = Audio(video_url=None, video_title=media_file.filename, source_type="upload", file_path=str(saved_path), status="processing")
        db.session.add(audio)
        db.session.commit()

        try:
            extracted_audio = extract_audio_from_video(saved_path)
            segments = generate_captions(audio_path=extracted_audio)
            audio.transcript_segments = [segment.to_dict() for segment in segments]
            audio.sound_tags = []
            audio.status = "ready"
            db.session.commit()

            for segment in segments:
                db.session.add(TranscriptSegment(
                    audio_id=audio.id,
                    start_time=segment.start,
                    end_time=segment.end,
                    speaker_label=segment.speaker,
                    text=segment.text,
                    confidence=segment.confidence,
                ))
            db.session.commit()
        except FileNotFoundError as error:
            audio.status = "error"
            db.session.commit()
            return jsonify({"error": str(error)}), 500
        except RuntimeError as error:
            audio.status = "error"
            db.session.commit()
            return jsonify({"error": str(error)}), 500

        return jsonify({
            "id": audio.id,
            "video_title": audio.video_title,
            "captions": audio.transcript_segments,
            "video_url": f"/uploads/{Path(audio.file_path).name}",
        })

    @app.get("/api/audio/<int:audio_id>")
    def get_audio(audio_id: int):
        audio = Audio.query.get_or_404(audio_id)
        return jsonify(audio.to_dict())

    @app.get("/api/audio/<int:audio_id>/captions.srt")
    def download_srt(audio_id: int):
        audio = Audio.query.get_or_404(audio_id)
        content = segments_to_srt(audio.transcript_segments or [])
        temp_path = BASE_DIR / f"audio-{audio_id}.srt"
        temp_path.write_text(content, encoding="utf-8")
        return send_file(temp_path, as_attachment=True, download_name=f"audio-{audio_id}.srt")

    @app.get("/api/audio/<int:audio_id>/captions.vtt")
    def download_vtt(audio_id: int):
        audio = Audio.query.get_or_404(audio_id)
        content = segments_to_vtt(audio.transcript_segments or [])
        temp_path = BASE_DIR / f"audio-{audio_id}.vtt"
        temp_path.write_text(content, encoding="utf-8")
        return send_file(temp_path, as_attachment=True, download_name=f"audio-{audio_id}.vtt")

    return app


if __name__ == "__main__":
    create_app().run(debug=True)
