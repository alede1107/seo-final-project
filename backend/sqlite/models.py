from datetime import datetime

from flask_sqlalchemy import SQLAlchemy


db = SQLAlchemy()


class Audio(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    video_url = db.Column(db.String(500), unique=True, index=True, nullable=True)
    video_title = db.Column(db.String(500), nullable=False)
    source_type = db.Column(db.String(50), nullable=False, default="upload")
    file_path = db.Column(db.String(1000), nullable=True)
    status = db.Column(db.String(50), nullable=False, default="pending")
    created_at = db.Column(db.DateTime, default=datetime.utcnow, nullable=False)
    updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)
    transcript_segments = db.Column(db.JSON, nullable=True)
    sound_tags = db.Column(db.JSON, nullable=True)

    def to_dict(self):
        return {
            "id": self.id,
            "video_url": self.video_url,
            "video_title": self.video_title,
            "source_type": self.source_type,
            "file_path": self.file_path,
            "status": self.status,
            "transcript_segments": self.transcript_segments or [],
            "sound_tags": self.sound_tags or [],
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "updated_at": self.updated_at.isoformat() if self.updated_at else None,
        }

    def __repr__(self):
        return f"Audio('{self.video_title}', '{self.video_url}')"


class TranscriptSegment(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    audio_id = db.Column(db.Integer, db.ForeignKey("audio.id"), nullable=False, index=True)
    start_time = db.Column(db.Float, nullable=False)
    end_time = db.Column(db.Float, nullable=False)
    speaker_label = db.Column(db.String(100), nullable=True)
    text = db.Column(db.Text, nullable=False)
    confidence = db.Column(db.Float, nullable=True)

    def to_dict(self):
        return {
            "start": self.start_time,
            "end": self.end_time,
            "text": self.text,
            "confidence": self.confidence,
        }
