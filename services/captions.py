from dataclasses import dataclass
from typing import List, Optional
import math
import os
import time


@dataclass
class CaptionSegment:
    start: float
    end: float
    text: str
    speaker: Optional[str] = None
    confidence: Optional[float] = None

    def to_dict(self):
        return {
            "start": self.start,
            "end": self.end,
            "speaker": self.speaker,
            "text": self.text,
            "confidence": self.confidence,
        }


def generate_captions(audio_path: str = None) -> List[CaptionSegment]:
    if audio_path and os.getenv("ASSEMBLYAI_API_KEY"):
        return _assemblyai_transcribe(audio_path)

    if audio_path and os.getenv("WHISPER_BACKEND", "").lower() == "local":
        return _local_whisper_transcribe(audio_path)

    return [
        CaptionSegment(start=0.0, end=2.5, text="No transcription provider configured.", confidence=1.0),
        CaptionSegment(start=2.5, end=5.0, text="Set ASSEMBLYAI_API_KEY or WHISPER_BACKEND=local.", confidence=1.0),
    ]


def segments_to_srt(segments):
    lines = []
    for index, segment in enumerate(segments, start=1):
        start = _format_timestamp(segment["start"])
        end = _format_timestamp(segment["end"])
        lines.extend([str(index), f"{start} --> {end}", segment["text"], ""])
    return "\n".join(lines).strip() + "\n"


def segments_to_vtt(segments):
    lines = ["WEBVTT", ""]
    for segment in segments:
        start = _format_timestamp(segment["start"], vtt=True)
        end = _format_timestamp(segment["end"], vtt=True)
        lines.extend([f"{start} --> {end}", segment["text"], ""])
    return "\n".join(lines).strip() + "\n"


def _format_timestamp(seconds: float, vtt: bool = False):
    whole = int(math.floor(seconds))
    hours = whole // 3600
    minutes = (whole % 3600) // 60
    secs = whole % 60
    millis = int(round((seconds - whole) * 1000))
    if millis == 1000:
        whole += 1
        millis = 0
    if vtt:
        return f"{hours:02d}:{minutes:02d}:{secs:02d}.{millis:03d}"
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{millis:03d}"


def _assemblyai_transcribe(audio_path: str):
    import requests

    api_key = os.environ["ASSEMBLYAI_API_KEY"]
    headers = {"authorization": api_key}

    with open(audio_path, "rb") as audio_file:
        upload_response = requests.post("https://api.assemblyai.com/v2/upload", headers=headers, data=audio_file)
    upload_response.raise_for_status()
    upload_url = upload_response.json()["upload_url"]

    transcript_response = requests.post(
        "https://api.assemblyai.com/v2/transcript",
        headers={**headers, "content-type": "application/json"},
        json={"audio_url": upload_url, "speaker_labels": True},
    )
    transcript_response.raise_for_status()
    transcript_id = transcript_response.json()["id"]

    while True:
        poll_response = requests.get(f"https://api.assemblyai.com/v2/transcript/{transcript_id}", headers=headers)
        poll_response.raise_for_status()
        payload = poll_response.json()
        if payload["status"] == "completed":
            break
        if payload["status"] == "error":
            raise RuntimeError(payload.get("error", "AssemblyAI transcription failed."))
        time.sleep(2)

    utterances = payload.get("utterances") or []
    if utterances:
        return [
            CaptionSegment(
                start=float(item["start"]) / 1000.0,
                end=float(item["end"]) / 1000.0,
                text=item["text"],
                speaker=f"Speaker {item.get('speaker', 1)}",
                confidence=item.get("confidence"),
            )
            for item in utterances
        ]

    paragraphs = payload.get("paragraphs", {}).get("paragraphs", [])
    return [
        CaptionSegment(
            start=float(item["start"]) / 1000.0,
            end=float(item["end"]) / 1000.0,
            text=item["text"],
            confidence=item.get("confidence"),
        )
        for item in paragraphs
    ]


def _local_whisper_transcribe(audio_path: str):
    try:
        import whisper
    except Exception:
        return []

    model_name = os.getenv("WHISPER_MODEL", "base")
    model = whisper.load_model(model_name)
    result = model.transcribe(audio_path)

    segments = []
    for item in result.get("segments", []):
        segments.append(
            CaptionSegment(
                start=float(item["start"]),
                end=float(item["end"]),
                text=item["text"].strip(),
                confidence=float(item.get("avg_logprob", 0.0)),
            )
        )
    return segments
