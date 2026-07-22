# CaptionAid

CaptionAid is a Chrome/Edge extension backed by Flask. The extension captures
audio from the YouTube tab, AssemblyAI transcribes each segment with speaker
labels, and the backend converts it to ASL gloss and matches clips from
`word_to_url.json`. Captions and sign clips appear in the YouTube overlay and in
the companion website's shared history.

## Prerequisites

- Python 3.11 or newer is recommended.
- Node.js 22+ for the React companion website.
- AWS credentials with access to the configured S3 bucket.
- AssemblyAI API key.
- Gemini API key is optional. Without it, the backend uses its deterministic
  fallback glossing logic.

The extension records browser-supported WebM/Opus audio chunks. FFmpeg and
server-side YouTube downloads are not required for the main workflow.

## One-Time Setup

Pick one environment (WSL, macOS, or Windows) and use it for both Python and
Node. Do not reuse `venv` or `frontend/node_modules` between WSL and Windows;
their native packages are different.

Create one virtual environment at the repository root and install the backend:

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
```

On Windows PowerShell, activate with:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
```

Install the companion website from that same environment:

```bash
cd frontend
npm ci --include=optional
cd ..
```

Confirm Node is visible:

```bash
node --version
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

## Run Every Day

Start the backend from the repository root:

```bash
source .venv/bin/activate
python3 app.py
```

On Windows PowerShell, activate with `.\.venv\Scripts\Activate.ps1` and run
`python app.py` instead.

The backend runs at `http://127.0.0.1:5001`. Verify it in another terminal:

```bash
curl http://127.0.0.1:5001/health
```

The response should be `{"ok":true}`.

## Run The Companion Website

The React companion website and browser extension use the same Flask API and
caption records. Keep the backend running, then use a second terminal:

```bash
cd frontend
npm run dev
```

Open `http://127.0.0.1:5173`. Vite proxies `/api` requests to the Flask
backend at `http://127.0.0.1:5001`.

The website stays focused on two real workflows:

- `/` reviews caption history, captions, ASL gloss, and matched clips. **Open
  YouTube video** accepts a YouTube URL and opens the tab where the extension
  captures audio.
- `/signs` searches and plays entries from the complete `word_to_url.json`
  vocabulary.

Deleting a History item removes its transcript and matched clips. In the
deployed S3-backed app it also removes that video's captured audio and job
files.

The History page refreshes automatically while the extension processes a video.

For a production-style local build, compile the frontend first and then start
Flask. Flask serves the built site and API from the same port:

```bash
cd frontend
npm ci --include=optional
npm run build
cd ..
python3 app.py
```

Then open `http://127.0.0.1:5001`.

## Deploy To Vercel

The repository includes `Dockerfile.vercel`, so the companion website and
Flask API deploy together as one Vercel project and share one URL. The image
builds the React site, runs Python 3.12, and serves the production build through
Gunicorn.

Production does not use SQLite for extension captions. Vercel instances are
temporary, so every AssemblyAI chunk job and caption result is stored in the
existing S3 bucket under `captionaid/v2/`. No additional database is required.

1. Push this branch to the repository hosted on GitHub.
2. In Vercel, choose **Add New > Project** and import the repository.
3. In **Settings > Build and Deployment**, set the Framework Preset to
   **Services**. Keep the project root set to the repository root. Do not set a
   custom build command or output directory. `vercel.json` explicitly routes
   the deployment to `Dockerfile.vercel`.
4. Add these environment variables for Production and Preview:

```dotenv
CAPTION_AWS_ACCESS_KEY_ID=...
CAPTION_AWS_SECRET_ACCESS_KEY=...
AWS_REGION=us-east-2
S3_BUCKET=...
ASSEMBLYAI_API_KEY=...
GEMINI_API_KEY=...
```

The `CAPTION_AWS_*` values are the same IAM access key ID and secret normally
stored locally as `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`. The aliases
avoid collisions with platform-managed AWS variables inside Vercel containers;
the standard names remain supported for local development.

`GEMINI_API_KEY` is optional. The AWS identity needs `s3:GetObject`,
`s3:PutObject`, `s3:DeleteObject`, and `s3:ListBucket` access to the configured
bucket. Do not add `CAPTION_STORE`; the Vercel image sets it automatically.

5. Press **Deploy**. After the deployment is ready, open `/api/health` on its
   URL. A correctly configured deployment responds with `{"ok":true}` after
   verifying real access to the S3 bucket.
6. Reload the unpacked extension, open the deployed website, enter a YouTube
   URL, and follow the three steps shown in the dialog.

If `/api/health` returns `503`, its `missing` list names the environment
variables that still need to be added. After changing variables in Vercel,
redeploy so the new values reach the running app.

## Load The Extension

1. Open `edge://extensions` or `chrome://extensions`.
2. Enable Developer mode.
3. Choose **Load unpacked** and select the repository's `extension` folder.
4. After any extension code change, press **Reload** on the extension card and
   refresh the YouTube tab.
5. Open a public YouTube video and start playing it.
6. Open CaptionAid and press **Prepare captions**. The overlay appears and
   fills with captions and sign clips as each audio segment finishes.
7. Press **Stop CaptionAid** when finished. Keep the YouTube tab open for a few
   seconds so the final caption can appear.

The extension uses `https://seo-final-project.vercel.app` by default so its
captions always appear in the deployed companion website. For local extension
development, set `captionAidBackend` in `chrome.storage.local` to
`http://localhost:5001`; clear that override before the deployed demo.

## Verify

Run the local pipeline verification without making AssemblyAI or YouTube calls:

```bash
python -m unittest discover -s tests -v
python backend/verify_pipeline.py
cd frontend && npm run build
```

For a full caption test, use the extension and then inspect the result:

```bash
curl http://127.0.0.1:5001/captions/video/VIDEO_ID
curl http://127.0.0.1:5001/api/sessions
```

A successful caption chunk has `status: "ready"`, transcript text, an optional
`speaker_label`, non-empty `gloss`, and non-empty `clips` when vocabulary words
match. YouTube media is captured by the browser extension instead of downloaded
from a cloud server, avoiding YouTube's Vercel bot-check failure.
