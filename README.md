# CaptionAid

CaptionAid is a Chrome/Edge extension backed by Flask. It prepares captions for
a public YouTube video, converts each transcript segment to ASL gloss, matches
the gloss against `word_to_url.json`, and plays the matched clips in an overlay
that follows the YouTube playhead.

## Prerequisites

- Python 3.11 or newer is recommended. Python 3.10 still runs today, but current
  yt-dlp releases warn that support will be removed soon.
- Node.js 22+ or Deno 2.3+ must be available in the same terminal that runs the
  backend. yt-dlp now requires a JavaScript runtime for reliable YouTube access.
- AWS credentials with access to the configured S3 bucket.
- AssemblyAI API key.
- Gemini API key is optional. Without it, the backend uses its deterministic
  fallback glossing logic.

The prepared-caption path does not require FFmpeg. It uploads the audio format
provided by YouTube directly to S3.

## Install

Create one virtual environment at the repository root and install the pinned
dependencies:

```bash
python3 -m venv venv
source venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
```

On Windows PowerShell, activate with:

```powershell
python -m venv venv
.\venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
```

Confirm the JavaScript runtime is visible. One of these must succeed:

```bash
node --version
deno --version
```

## Environment

Create `.env` in the repository root from `.env.example`. These names are
exact; boto3 and the backend will not read aliases such as `AWS_ACCESS_KEY` or
`ASSEMBLY_AI`.

```dotenv
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
AWS_REGION=us-east-2
S3_BUCKET=...
ASSEMBLYAI_API_KEY=...
GEMINI_API_KEY=...
```

Do not commit `.env`.

## Run

From the repository root:

```bash
source venv/bin/activate
python -m backend.app
```

The backend runs at `http://127.0.0.1:5001`. Verify it in another terminal:

```bash
curl http://127.0.0.1:5001/health
```

The response should be `{"ok":true}`.

## Load The Extension

1. Open `edge://extensions` or `chrome://extensions`.
2. Enable Developer mode.
3. Choose **Load unpacked** and select the repository's `extension` folder.
4. After any extension code change, press **Reload** on the extension card and
   refresh the YouTube tab.
5. Open a public YouTube video, open CaptionAid, and press **Prepare captions**.
6. Wait for **Captions ready**, then press **Show captions** and play the video.

## Verify

Run the local pipeline verification without making AssemblyAI or YouTube calls:

```bash
python -m unittest discover -s tests -v
python backend/verify_pipeline.py
```

For a full prepared-caption test, use the extension and then inspect the result:

```bash
curl http://127.0.0.1:5001/prepare/VIDEO_ID
curl http://127.0.0.1:5001/captions/video/VIDEO_ID
```

A successful result has `status: "ready"`; caption chunks should include
non-empty `gloss` and, when vocabulary words match, non-empty `clips`.

## YouTube Download Errors

If the backend reports HTTP 403, first verify that the backend terminal can see
Node 22+ or Deno 2.3+, then reinstall the project dependencies:

```bash
node --version
python -m pip install --upgrade --force-reinstall -r requirements.txt
```

CaptionAid can prepare ordinary public videos. Private, members-only,
age-restricted, region-blocked, or bot-challenged videos may still require
authentication and are outside the MVP's guaranteed path.
