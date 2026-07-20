from __future__ import annotations

import json
import re
from functools import lru_cache
from pathlib import Path
from typing import Any, Optional


BASE_DIR = Path(__file__).resolve().parents[1]
WORD_TO_URL_PATH = BASE_DIR / "word_to_url.json"


@lru_cache(maxsize=1)
def load_word_to_url_map() -> dict[str, str]:
    """Load the fixed WLASL word -> clip URL mapping from disk."""
    with WORD_TO_URL_PATH.open("r", encoding="utf-8") as f:
        return json.load(f)


def normalize_text(text: str) -> list[str]:
    """Lowercase and split transcript text into searchable words."""
    cleaned = re.sub(r"[^a-zA-Z0-9']+", " ", text.lower())
    return [word for word in cleaned.split() if word]


def process_chunk(chunk: dict[str, Any]) -> Optional[dict[str, Any]]:
    """
    Process one finalized transcript chunk.

    Expected chunk shape:
    {
        "speaker": str | None,
        "text": str,
        "is_final": bool,
        "start": float | int | None,
        "end": float | int | None,
    }

    Returns a match payload when a vocabulary word is found, otherwise None.
    """
    if not chunk.get("is_final"):
        return None

    text = chunk.get("text", "")
    words = normalize_text(text)
    word_to_url = load_word_to_url_map()

    for word in words:
        if word in word_to_url:
            return {
                "speaker": chunk.get("speaker"),
                "word": word,
                "clip_url": word_to_url[word],
                "start": chunk.get("start"),
                "end": chunk.get("end"),
                "text": text,
            }

    return None