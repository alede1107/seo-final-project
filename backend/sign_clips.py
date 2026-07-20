"""
ASL gloss text look up in-order to URL ub ../word_to_url.json
    - ignore token if not exist
Gloss token -> ASL sign-clip URL matching

"""

import json
import re
from functools import lru_cache
from pathlib import Path

# word_to_url.json lives at the repo root, one level above backend/.
_WORD_MAP_PATH = "./word_to_url.json"


@lru_cache(maxsize=1)
def load_word_map() -> dict:
    """
    Load and cache the word->clip-url map
    
    Returns {} if the file is missing
        so a deploy without the dictionary degrades to 'no clips'
    
    """
    try:
        with open(_WORD_MAP_PATH, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return {}


def _normalize(token: str) -> str:
    """
    Lowercase and strip to [a-z0-9'] 
        - matches the dictionary key convention from @Alejandro
        - chunk_processor.normalize_text 
    
    Collapses e.g. 'QUESTION-MARK' -> 'question'
    on the first run; multi-token normalization
    """

    cleaned = re.sub(r"[^a-z0-9']+", " ", token.lower()).strip()
    return cleaned


def match_gloss(tokens) -> list:
    """
    Map an ordered list of gloss tokens to sign clips.

    Returns [{"token", "url"}, ...] preserving gloss order, one entry per token
    that has a clip. 
        - Misses are skipped — including grammatical markers like
            QUESTION-MARK, which normalize to a multi-word string ("question mark") and
        only match if that exact phrase is a dictionary key
        - Multi-word phrase keys (e.g. "thank you") match
            when a gloss token normalizes to that exact phrase.
    
    """
    
    word_map = load_word_map()
    out = []
    for token in tokens or []:
        norm = _normalize(str(token))
        if not norm:
            continue
        url = word_map.get(norm)
        if url is not None:
            out.append({"token": str(token).upper(), "url": url})
    return out
