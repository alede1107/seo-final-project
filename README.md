# SEO Final Project Backend

Flask backend for video file upload and caption overlay playback.

## Endpoints

- `POST /api/upload` with `file`
- `GET /api/audio/<id>`
- `GET /uploads/<filename>`

## Environment

Create a `.env` file in the project root. Recommended values:

- `DATABASE_URL=sqlite:///app.db` for local development
- `MAX_CONTENT_LENGTH=524288000` for 500 MB uploads
- `ASSEMBLYAI_API_KEY=...` for hosted transcription with speaker labels
- `WHISPER_BACKEND=local` if you want to run Whisper locally instead of AssemblyAI
- `WHISPER_MODEL=base` or `small` for local Whisper speed/accuracy tradeoff
- `FFMPEG_BIN=ffmpeg` if `ffmpeg` is not already on your PATH

Windows note: install ffmpeg separately and confirm `ffmpeg -version` works in a terminal before running the app.

You do not need any ASL or YouTube variables anymore.

## Run

```bash
pip install -r requirements.txt
python app.py
```

Open `http://127.0.0.1:5000/` in the browser. The root URL now serves the upload page and shows the uploaded video with captions overlaid.

If upload returns an ffmpeg error, the video file is fine but your machine still needs ffmpeg installed.
