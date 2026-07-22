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

The React companion website is separate from the browser extension, but both
use the same Flask API and caption database. Keep the backend running, then use
a second terminal in the same environment:

```bash
cd frontend
npm run dev
```

Open `http://127.0.0.1:5173`. Vite proxies `/api` requests to the Flask
backend at `http://127.0.0.1:5001`.

The website stays focused on two real workflows:

- `/` reviews preparation history, captions, ASL gloss, and matched clips. The
  **Prepare video** button accepts a public YouTube URL.
- `/signs` searches and plays entries from the complete `word_to_url.json`
  vocabulary.

Deleting a History item removes its prepared transcript and matched clips from
the local database. It does not delete live-capture sessions. In the deployed
S3-backed app it also removes that video's stored source audio and job files.

The browser extension remains the third user-facing surface and uses the same
backend and caption records.

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
builds the React site, includes Node 22 for yt-dlp, runs Python 3.12, and serves
the production build through Gunicorn.

Production does not use SQLite for prepared videos. Vercel instances are
temporary, so preparation jobs and caption results are stored in the existing
S3 bucket under `captionaid/v2/`. No additional database is required.

1. Push this branch to the repository hosted on GitHub.
2. In Vercel, choose **Add New > Project** and import the repository.
3. In **Settings > Build and Deployment**, set the Framework Preset to
   **Services**. Keep the project root set to the repository root. Do not set a
   custom build command or output directory. `vercel.json` explicitly routes
   the deployment to `Dockerfile.vercel`.
4. Add these environment variables for Production and Preview:

```dotenv
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
AWS_REGION=us-east-2
S3_BUCKET=...
ASSEMBLYAI_API_KEY=...
GEMINI_API_KEY=...
```

`GEMINI_API_KEY` is optional. The AWS identity needs `s3:GetObject`,
`s3:PutObject`, `s3:DeleteObject`, and `s3:ListBucket` access to the configured
bucket. Do not add `CAPTION_STORE`; the Vercel image sets it automatically.

5. Press **Deploy**. After the deployment is ready, open `/api/health` on its
   URL. A correctly configured deployment responds with `{"ok":true}`.
6. Open the deployment URL, prepare a short public YouTube video, and leave the
   preparation dialog open until it finishes. The browser polls the API, which
   safely resumes transcription and sign matching across Vercel invocations.

If `/api/health` returns `503`, its `missing` list names the environment
variables that still need to be added. After changing variables in Vercel,
redeploy so the new values reach the running app.

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
cd frontend && npm run build
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
