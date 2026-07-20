from __future__ import annotations

import json
import re
import sys
from functools import lru_cache
from pathlib import Path
from typing import Any
from backend.text_to_gloss import to_gloss  


_BACKEND = Path(__file__).resolve().parents[1] / "backend"
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))


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


def match_gloss(tokens, words=None, chunk_duration=None) -> list:
    """Map ASL gloss tokens to sign clips in gloss order.

    Returns [{"token", "url", "target_duration"}, ...]. target_duration (seconds)
    is how long the clip should play so the full set fits within chunk_duration.
    Proportions come from word-level timing in `words`; falls back to equal
    distribution when timing is unavailable. Tokens with no dictionary entry
    (e.g. QUESTION-MARK, HERSELF) are skipped."""
    word_map = load_word_map()
    cd = chunk_duration if chunk_duration and chunk_duration > 0 else 10.0

    # Build normalized-word → duration-in-seconds map from AssemblyAI word list.
    word_dur: dict[str, float] = {}
    for w in (words or []):
        norm = re.sub(r"[^a-z0-9']+", " ", (w.get("text") or "").lower()).strip()
        dur = max(0.0, (w.get("end", 0) - w.get("start", 0)) / 1000.0)
        if norm:
            word_dur[norm] = word_dur.get(norm, 0.0) + dur

    # Match tokens to clip URLs and stash per-token word durations.
    matched: list[dict] = []
    for token in tokens or []:
        norm = _normalize(str(token))
        if norm and (url := word_map.get(norm)):
            matched.append({
                "token": str(token).upper(),
                "url": url,
                "_wd": word_dur.get(norm),  # seconds; None if not in words
            })

    if not matched:
        return []

    total_wd = sum(c["_wd"] for c in matched if c["_wd"] is not None)

    if total_wd > 0:
        # Proportional: each clip's share = (its word duration / total) * chunk.
        timed = [c for c in matched if c["_wd"] is not None]
        untimed = [c for c in matched if c["_wd"] is None]
        for c in timed:
            c["target_duration"] = round(max(0.1, (c["_wd"] / total_wd) * cd), 3)
        if untimed:
            used = sum(c["target_duration"] for c in timed)
            share = max(0.1, (cd - used) / len(untimed))
            for c in untimed:
                c["target_duration"] = round(share, 3)
    else:
        # No word timing — distribute chunk evenly.
        equal = round(max(0.1, cd / len(matched)), 3)
        for c in matched:
            c["target_duration"] = equal

    return [{"token": c["token"], "url": c["url"], "target_duration": c["target_duration"]}
            for c in matched]


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
