"""
Text to ASL constrants:
- We can't use facial or body expressions
- text should be formatted to how ASL is structured, for example:
    - Deaf people typically do not sign "YOU WHAT NAME?"
    - Deaf people typically do not sign "YOU NAME WHAT?"
    - Deaf people do typically sign "YOU NAME?"
    - Reference: https://www.lifeprint.com/asl101/topics/gloss.htm#gsc.tab=0


"""

import json
import os
import re
from google.genai import types
from google import genai

# Model Level
GEMINI_MODEL = "gemini-2.5-flash"
SYSTEM_PROMPT = """

You are an expert English-to-ASL Gloss translator. Your task is to take English transcripts and convert them into ASL Gloss. 

Follow these strict linguistic rules:
1. Syntax: Convert English Subject-Verb-Object (SVO) into ASL Topic-Comment (OSV) structure. 
2. Omissions: Remove all articles (a, an, the), conjugations of "to be" (is, am, are, was, were), and English punctuation.
3. Plurals: Do not use 's'. (e.g., "cars" becomes "CAR CAR" or "MANY CAR").
4. Tense: Move time indicators to the front of the sentence (e.g., "I will go tomorrow" becomes "TOMORROW I GO").
5. Questions: Because the video output lacks facial expressions, you MUST add the word "QUESTION-MARK" to the end of any interrogative sentence. (e.g., "Are you going to the store?" becomes "STORE YOU GO QUESTION-MARK").

Output Constraint:
Return ONLY a JSON array of capitalized string values representing the ASL Gloss. Do not include markdown, explanations, or any other text. 

Example Input: "She is doing her homework on the highway."
Example Output: ["HIGHWAY", "HERSELF", "HOMEWORK", "DO"]

"""

# MOCKING
# mocking to manually remove stop words
_MOCK_STOPWORDS = {
    "a", "an", "the", "is", "am", "are", "was", "were", "be", "been", "being",
    "to", "of", "and", "or",
}
_client = None

def clean_audio_artifacts(text: str) -> str:
    """
    Remove content where Whisper produces meta data in transcriptions 
        - e.g. Noises - [cough], [laught]
        - e.g. Diarzations - "Speaker 1:"
    """


    # Remove transcription noise like [coughs], (laughter), or [music]
    text = re.sub(r'\[.*?\]|\(.*?\)', '', text)
    
    # Remove speaker diarization artifacts like "Speaker 1:" or "Josh:"
    text = re.sub(r'^(Speaker \d+:|[A-Z][a-z]+:)\s*', '', text)
    
    return text.strip()

def remove_conversational_fillers(text: str) -> str:
    """
    Remove filler words
        - e.g., "I like apples" stays, but "It was, um, like, huge" gets cleaned

    """

    fillers = [r'\bum\b', r'\buh\b', r'\bhm+\b', r'\byou know\b', r'\bliterally\b']
    
    for filler in fillers:
        text = re.sub(filler, '', text, flags = re.IGNORECASE)
    
    # Clean up double spaces
    return re.sub(r'\s+', ' ', text).strip()

def expand_contractions(text: str) -> str:
    """
    Explicitly show negation or any contractions.
    Our transcriptions is limited by words and fixed ASL videos, so negations should be explicit.
    """

    contractions = {
        r"don't": "do not",
        r"can't": "cannot",
        r"won't": "will not",
        r"isn't": "is not",
        r"aren't": "are not",
        r"didn't": "did not",
        r"shouldn't": "should not",
        r"couldn't": "could not",
        r"wouldn't": "would not"
    }
    
    for pattern, replacement in contractions.items():
        text = re.sub(pattern, replacement, text, flags = re.IGNORECASE)
        
    return text

def normalize_symbols(text: str) -> str:
    """
    Output symbols to text
    """
    text = text.replace('%', ' percent')
    text = text.replace('$', 'dollars ') # $50 -> dollars 50 -> LLM fixes syntax
    text = text.replace('&', ' and ')
    
    return re.sub(r'\s+', ' ', text).strip()

def process_transcript_pipeline(raw_transcript: str) -> str:
    """
    Puts Regex and String level functions together. 
    Orchestrator function that runs before the LLM call.
    """

    text = clean_audio_artifacts(raw_transcript)
    text = expand_contractions(text)
    text = remove_conversational_fillers(text)
    text = normalize_symbols(text)
    return text


def _mock_gloss(cleaned: str) -> list:
    """
    MOCKING LLM removing stopwords and meaningless words :

    Uppercase the cleaned words and drop a few stopwords so
    the output still resembles gloss. Used when GEMINI_API_KEY is unset (parallel
    to the ASSEMBLYAI mock mode) and as a safety net when the model call fails.
    
    """
    words = re.findall(r"[A-Za-z0-9']+", cleaned)
    return [w.upper() for w in words if w.lower() not in _MOCK_STOPWORDS]


def _get_client():
    
    global _client

    # Call once | singleton
    if _client is not None:
        return _client
    # mocking
    if not (os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")):
        return None
    
    # initialize client
    _client = genai.Client()
    return _client


def to_gloss(text: str) -> list:
    """
    Translate an English transcript span into an ASL Gloss token list.
    """

    if not text or not text.strip():
        return []

    cleaned = process_transcript_pipeline(text)
    if not cleaned:
        return []

    client = _get_client()
    if client is None:
        return _mock_gloss(cleaned)

    try:
        

        resp = client.models.generate_content(
            model       = GEMINI_MODEL,
            contents    = cleaned,
            config      = types.GenerateContentConfig(
                system_instruction = SYSTEM_PROMPT,
                response_mime_type = "application/json",
            ),
        )

        tokens = json.loads(_strip_fences(resp.text or ""))

        if not isinstance(tokens, list):
            raise ValueError("model did not return a JSON array")
        
        # Coerce to clean uppercase strings; drop anything non-stringy
        return [str(t).strip().upper() for t in tokens if str(t).strip()]
    
    except Exception: 
        return _mock_gloss(cleaned)


def _strip_fences(s: str) -> str:
    """
    Defensively strip ```json ... ``` fences the model may emit despite the
    JSON output constraint, so json.loads sees a bare array.
    
    """
    s = s.strip()
    if s.startswith("```"):
        s = re.sub(r"^```[a-zA-Z]*\n?", "", s)
        s = re.sub(r"\n?```$", "", s)
    return s.strip()