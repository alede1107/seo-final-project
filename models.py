from flask_sqlalchemy import SQLAlchemy

db = SQLAlchemy()

class Audio(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    video_url = db.Column(db.String(500), unique=True, index=True)
    video_title = db.Column(db.String(500))
    transcript_segments = db.Column(db.JSON, default=list, nullable=False)
    sound_tags = db.Column(db.JSON, default=list, nullable=False)
    sign_matches = db.Column(db.JSON, default=list, nullable=False)

    def __repr__(self):
        return f"Audio('{self.video_title}', '{self.video_url}')"

# Upsert Audio by video_url. Fields left as None keep their prior value.
def save_audio_record(video_url, video_title=None, transcript_segments=None, sound_tags=None, sign_matches=None):
    audio = Audio.query.filter_by(video_url=video_url).first()
    if audio is None:
        audio = Audio(video_url=video_url, transcript_segments=[], sound_tags=[], sign_matches=[])
        db.session.add(audio)

    if video_title is not None:
        audio.video_title = video_title
    if transcript_segments is not None:
        audio.transcript_segments = transcript_segments
    if sound_tags is not None:
        audio.sound_tags = sound_tags
    if sign_matches is not None:
        audio.sign_matches = sign_matches

    db.session.commit()
    return audio
