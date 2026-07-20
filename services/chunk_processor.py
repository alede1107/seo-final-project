from __future__ import annotations

import json
import re
import sys
from functools import lru_cache
from pathlib import Path
from typing import Any

_BACKEND = Path(__file__).resolve().parents[1] / "backend"
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

from backend.text_to_gloss import to_gloss  

# word_to_url.json is at the repo root (one level above services/).
_WORD_MAP_PATH = Path(__file__).resolve().parents[1] / "word_to_url.json"

@lru_cache(maxsize=1)
def load_word_map() -> dict:
    """Load and cache the WLASL word 
        to clip-URL map. Returns {} if missing."""
    try:
        with open(_WORD_MAP_PATH, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return {}


def _normalize(token: str) -> str:
    """Lowercase and strip to [a-z0-9'] to match dictionary key convention."""
    return re.sub(r"[^a-z0-9']+", " ", token.lower()).strip()


def match_gloss(tokens) -> list:
    """Map ASL gloss tokens to sign clips in gloss order.

    Returns [{"token", "url"}, ...]. Tokens with no dictionary entry (e.g.
    QUESTION-MARK, HERSELF) are skipped rather than mismatched."""
    word_map = load_word_map()
    out = []
    for token in tokens or []:
        norm = _normalize(str(token))
        if norm and (url := word_map.get(norm)):
            out.append({"token": str(token).upper(), "url": url})
    return out


def process_chunk(chunk: dict[str, Any]) -> list[dict[str, Any]]:
    """Process one finalized transcript chunk into matched ASL sign clips.

    Expected chunk shape:
        {"speaker": str|None, "text": str, "is_final": bool,
         "start": float|None, "end": float|None}

    Returns clips in ASL gloss order (Topic-Comment, content words), each:
        {"speaker", "word" (gloss token), "clip_url", "start", "end",
         "text" (original English), "word_index" (position in gloss)}

    Raw English is converted to ASL gloss first so clips reflect actual signs
    rather than surface word forms (e.g. "elephants" → ELEPHANT gets a clip;
    function words like "are", "the" are dropped by the gloss translator).
    """
    if not chunk.get("is_final"):
        return []

    text = chunk.get("text", "")
    if not text:
        return []

    gloss_tokens = to_gloss(text)
    clip_entries = match_gloss(gloss_tokens)

    speaker = chunk.get("speaker")
    start = chunk.get("start")
    end = chunk.get("end")

    return [
        {
            "speaker": speaker,
            "word": entry["token"],
            "clip_url": entry["url"],
            "start": start,
            "end": end,
            "text": text,
            "word_index": idx,
        }
        for idx, entry in enumerate(clip_entries)
    ]
