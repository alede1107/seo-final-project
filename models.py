from flask_sqlalchemy import SQLAlchemy

db = SQLAlchemy()

class Audio(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    video_url = db.Column(db.String(500), unique=True, index=True)
    video_title = db.Column(db.String(500))
    transcript_segments = db.Column(db.JSON)
    sound_tags = db.Column(db.JSON)
    sign_matches = db.Column(db.JSON)

    def __repr__(self):
        return f"Audio('{self.video_title}', '{self.video_url}')"
    
class WLASLSign(db.Model):
    word = db.Column(db.String(100), primary_key=True)
    video_id = db.Column(db.String(500))

    def __repr__(self):
        return f"Sign('{self.word}', '{self.video_id}')"
