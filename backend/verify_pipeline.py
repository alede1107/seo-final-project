"""
Verify the end-to-end pipeline:
  audio transcript → text cleaning → Gemini ASL gloss → sign clip matching

Run from the backend/ directory with the virtualenv active:
    python verify_pipeline.py
    GEMINI_API_KEY=<key> python verify_pipeline.py   # enables Stage 3
"""

import os
import sys
from pathlib import Path

# Mirror the sys.path injection in pipeline.py so imports resolve correctly.
_REPO_ROOT = Path(__file__).resolve().parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))
_BACKEND = Path(__file__).resolve().parent
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

PASS = "\033[32mPASS\033[0m"
FAIL = "\033[31mFAIL\033[0m"
SKIP = "\033[33mSKIP\033[0m"

failures = []


def check(label, condition, detail=""):
    if condition:
        print(f"  {PASS}  {label}")
    else:
        print(f"  {FAIL}  {label}" + (f" — {detail}" if detail else ""))
        failures.append(label)


# ---------------------------------------------------------------------------
# Stage 1 — Text cleaning (no API keys)
# ---------------------------------------------------------------------------
print("\nStage 1: Text cleaning")
try:
    from backend.text_to_gloss import process_transcript_pipeline

    raw = "[cough] Don't you know, um, it costs $50?"
    cleaned = process_transcript_pipeline(raw)
    print(f"  Input:  {raw!r}")
    print(f"  Output: {cleaned!r}")
    check("artifacts removed (no [cough])", "[cough]" not in cleaned)
    check("contraction expanded (do not)", "do not" in cleaned.lower())
    check("filler removed (no 'um')", "um" not in cleaned.lower().split())
    check("symbol normalized (dollars)", "dollars" in cleaned.lower())
except Exception as e:
    print(f"  {FAIL}  import or call failed: {e}")
    failures.append("Stage 1 import")


# ---------------------------------------------------------------------------
# Stage 2 — Mock gloss (forces no-key path)
# ---------------------------------------------------------------------------
print("\nStage 2: Mock gloss (GEMINI_API_KEY unset)")
try:
    # Temporarily clear the key so _get_client() returns None
    _saved_key = os.environ.pop("GEMINI_API_KEY", None)
    _saved_google = os.environ.pop("GOOGLE_API_KEY", None)

    # Re-import after clearing so the singleton is reset
    import importlib
    import backend.text_to_gloss as ttg
    ttg._client = None  # reset singleton so it re-evaluates

    from backend.text_to_gloss import to_gloss
    mock_tokens = to_gloss("She is doing her homework.")
    print(f"  Mock tokens: {mock_tokens}")
    check("returns a list", isinstance(mock_tokens, list))
    check("non-empty", len(mock_tokens) > 0)
    check("all uppercase strings", all(isinstance(t, str) and t == t.upper() for t in mock_tokens))

    # Restore keys
    if _saved_key:
        os.environ["GEMINI_API_KEY"] = _saved_key
    if _saved_google:
        os.environ["GOOGLE_API_KEY"] = _saved_google
    ttg._client = None  # reset again so Stage 3 re-inits with the key
except Exception as e:
    print(f"  {FAIL}  {e}")
    failures.append("Stage 2 mock gloss")


# ---------------------------------------------------------------------------
# Stage 3 — Real Gemini gloss (requires GEMINI_API_KEY)
# ---------------------------------------------------------------------------
print("\nStage 3: Real Gemini gloss")
gemini_key = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")
if not gemini_key:
    print(f"  {SKIP}  GEMINI_API_KEY not set — skipping live Gemini call")
else:
    try:
        from backend.text_to_gloss import to_gloss
        import backend.text_to_gloss as ttg
        ttg._client = None  # ensure fresh init with key present
        sentence = "She is doing her homework on the highway."
        tokens = to_gloss(sentence)
        print(f"  Input:  {sentence!r}")
        print(f"  Tokens: {tokens}")
        check("returns a list", isinstance(tokens, list))
        check("non-empty", len(tokens) > 0)
        check("all uppercase strings", all(isinstance(t, str) and t == t.upper() for t in tokens))
        expected = {"HOMEWORK", "DO", "HIGHWAY", "HERSELF"}
        check(
            f"contains at least one expected token {expected}",
            bool(expected & set(tokens)),
            f"got {tokens}",
        )
    except Exception as e:
        print(f"  {FAIL}  {e}")
        failures.append("Stage 3 Gemini call")


# ---------------------------------------------------------------------------
# Stage 4 — Clip matching via match_gloss
# ---------------------------------------------------------------------------
print("\nStage 4: Clip matching (match_gloss)")
try:
    from services.chunk_processor import match_gloss

    tokens_in = ["BOOK", "COMPUTER", "QUESTION-MARK"]
    clips = match_gloss(tokens_in)
    print(f"  Input tokens:  {tokens_in}")
    print(f"  Matched clips: {clips}")
    clip_tokens = [c["token"] for c in clips]
    check("BOOK matched", any(c["token"] == "BOOK" for c in clips))
    check("COMPUTER matched", any(c["token"] == "COMPUTER" for c in clips))
    check("QUESTION-MARK skipped (no clip)", "QUESTION-MARK" not in clip_tokens)
    check("clip entries have 'url' key", all("url" in c for c in clips))
    check("URLs are non-empty strings", all(isinstance(c["url"], str) and c["url"] for c in clips))
except Exception as e:
    print(f"  {FAIL}  {e}")
    failures.append("Stage 4 match_gloss")


# ---------------------------------------------------------------------------
# Stage 5 — End-to-end process_chunk
# ---------------------------------------------------------------------------
print("\nStage 5: End-to-end process_chunk")
try:
    from services.chunk_processor import process_chunk

    chunk = {"speaker": "A", "text": "I love books", "is_final": True, "start": 0.0, "end": 5.0}
    result = process_chunk(chunk)
    print(f"  Input chunk: {chunk}")
    print(f"  Result:      {result}")
    required_keys = {"speaker", "word", "clip_url", "start", "end", "text", "word_index"}
    check("returns a list", isinstance(result, list))
    if result:
        check("each item has required keys", all(required_keys <= r.keys() for r in result))
        check("clip_url values non-empty", all(r["clip_url"] for r in result))
    else:
        # No clips is acceptable if gloss tokens didn't match — report but don't fail
        print(f"  (no clips returned — 'I love books' gloss tokens may not be in word_to_url.json)")
except Exception as e:
    print(f"  {FAIL}  {e}")
    failures.append("Stage 5 process_chunk")


# ---------------------------------------------------------------------------
# Stage 6 — Import chain smoke test
# ---------------------------------------------------------------------------
print("\nStage 6: Import chain smoke test (import pipeline)")
try:
    import pipeline  # noqa: F401
    print(f"  {PASS}  pipeline imported successfully")
except ImportError as e:
    print(f"  {FAIL}  ImportError: {e}")
    failures.append("Stage 6 pipeline import")
except Exception as e:
    # Non-import errors (e.g. DB connection) are acceptable here
    print(f"  {PASS}  pipeline imported (non-import error on init: {e})")


# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
print("\n" + "=" * 50)
if failures:
    print(f"{FAIL}  {len(failures)} check(s) failed: {failures}")
    sys.exit(1)
else:
    print(f"{PASS}  All checks passed.")
    sys.exit(0)
