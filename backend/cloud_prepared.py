"""Durable caption jobs for stateless production runtimes.

Local development keeps using SQLite and background threads. Vercel uses this
store so whole-video jobs and extension audio chunks can resume from S3 without
depending on a particular process staying alive.
"""

from __future__ import annotations

import json
import time
from collections.abc import Callable
from typing import Any

import requests
from botocore.exceptions import ClientError


CaptionBuilder = Callable[[str, list[dict[str, Any]], float], tuple[list, list]]
Segmenter = Callable[[list[dict[str, Any]]], list[tuple[float, float, str, list]]]


class S3PreparedStore:
    """Persist preparation state, transcript segments, and captions in S3."""

    def __init__(
        self,
        s3_client,
        bucket: str,
        assemblyai_key: str,
        segmenter: Segmenter,
        caption_builder: CaptionBuilder,
        *,
        prefix: str = "captionaid/v2",
        batch_size: int = 4,
        http=requests,
    ):
        self.s3 = s3_client
        self.bucket = bucket
        self.assemblyai_key = assemblyai_key
        self.segmenter = segmenter
        self.caption_builder = caption_builder
        self.prefix = prefix.strip("/")
        self.batch_size = max(1, batch_size)
        self.http = http

    def _state_key(self, video_id: str) -> str:
        return f"{self.prefix}/prepared/{video_id}.json"

    def _segments_key(self, video_id: str) -> str:
        return f"{self.prefix}/segments/{video_id}.json"

    def _captions_key(self, video_id: str) -> str:
        return f"{self.prefix}/captions/{video_id}.json"

    def _live_key(self, session_id: str, chunk_index: int) -> str:
        return f"{self.prefix}/live/{session_id}/{chunk_index:05d}.json"

    def _live_prefix(self, session_id: str | None = None) -> str:
        base = f"{self.prefix}/live/"
        return f"{base}{session_id}/" if session_id else base

    def _put_json(self, key: str, payload: Any) -> None:
        self.s3.put_object(
            Bucket=self.bucket,
            Key=key,
            Body=json.dumps(payload, separators=(",", ":")).encode("utf-8"),
            ContentType="application/json",
        )

    def _get_json(self, key: str, default=None):
        try:
            response = self.s3.get_object(Bucket=self.bucket, Key=key)
        except ClientError as exc:
            code = str(exc.response.get("Error", {}).get("Code", ""))
            if code in {"404", "NoSuchKey", "NotFound"}:
                return default
            raise
        body = response["Body"].read()
        return json.loads(body.decode("utf-8"))

    def _list_keys(self, prefix: str) -> list[str]:
        keys: list[str] = []
        continuation_token = None
        while True:
            kwargs = {"Bucket": self.bucket, "Prefix": prefix}
            if continuation_token:
                kwargs["ContinuationToken"] = continuation_token
            response = self.s3.list_objects_v2(**kwargs)
            keys.extend(item["Key"] for item in response.get("Contents", []))
            if not response.get("IsTruncated"):
                return keys
            continuation_token = response.get("NextContinuationToken")

    def _save_state(self, state: dict[str, Any]) -> None:
        state["updated_at"] = time.time()
        self._put_json(self._state_key(state["video_id"]), state)

    def _save_live_state(self, state: dict[str, Any]) -> None:
        state["updated_at"] = time.time()
        self._put_json(
            self._live_key(state["session_id"], int(state["chunk_index"])),
            state,
        )

    @staticmethod
    def _public_state(state: dict[str, Any] | None, video_id: str) -> dict[str, Any]:
        if state is None:
            return {"video_id": video_id, "status": "none", "error": None}
        return {
            key: state.get(key)
            for key in (
                "video_id",
                "status",
                "error",
                "title",
                "duration",
                "created_at",
                "stage",
                "progress",
                "chunk_count",
                "sign_count",
                "transcript_preview",
                "source",
            )
        }

    def start(self, video_id: str) -> None:
        now = time.time()
        self._save_state(
            {
                "video_id": video_id,
                "status": "preparing",
                "stage": "fetching_audio",
                "progress": 5,
                "error": None,
                "title": None,
                "duration": None,
                "created_at": now,
            }
        )

    def mark_error(self, video_id: str, error: str) -> None:
        state = self._get_json(self._state_key(video_id), {})
        state.update(
            {
                "video_id": video_id,
                "status": "error",
                "stage": "error",
                "error": str(error),
            }
        )
        state.setdefault("created_at", time.time())
        self._save_state(state)

    def submit(
        self,
        video_id: str,
        audio_url: str,
        *,
        title: str | None,
        duration: float | None,
        source_key: str,
    ) -> None:
        response = self.http.post(
            "https://api.assemblyai.com/v2/transcript",
            headers={"authorization": self.assemblyai_key},
            json={"audio_url": audio_url, "punctuate": True, "format_text": True},
            timeout=30,
        )
        response.raise_for_status()
        transcript_id = response.json()["id"]

        state = self._get_json(self._state_key(video_id), {})
        state.update(
            {
                "video_id": video_id,
                "status": "preparing",
                "stage": "transcribing",
                "progress": 35,
                "error": None,
                "title": str(title).strip()[:300] if title else None,
                "duration": float(duration) if duration is not None else None,
                "transcript_id": transcript_id,
                "source_key": source_key,
            }
        )
        state.setdefault("created_at", time.time())
        self._save_state(state)

    @staticmethod
    def _public_live_state(state: dict[str, Any]) -> dict[str, Any]:
        return {
            key: state.get(key)
            for key in (
                "video_id",
                "session_id",
                "chunk_index",
                "status",
                "video_time_offset",
                "video_time_end",
                "text",
                "words",
                "gloss",
                "clips",
                "speaker_label",
                "error",
            )
        }

    def get_live_chunk(
        self,
        session_id: str,
        chunk_index: int,
        *,
        advance: bool = False,
    ) -> dict[str, Any] | None:
        state = self._get_json(self._live_key(session_id, chunk_index))
        if state and advance and state.get("status") == "pending":
            state = self._advance_live_chunk(state)
        return self._public_live_state(state) if state else None

    def submit_live_chunk(
        self,
        video_id: str,
        session_id: str,
        chunk_index: int,
        audio_url: str,
        *,
        video_time_offset: float,
        video_time_end: float,
        source_key: str,
        title: str | None = None,
    ) -> dict[str, Any]:
        """Submit one extension-captured chunk and persist its polling state."""
        existing = self._get_json(self._live_key(session_id, chunk_index))
        if existing and existing.get("status") in {"pending", "ready", "empty"}:
            return self._public_live_state(existing)

        now = time.time()
        state = {
            "video_id": video_id,
            "session_id": session_id,
            "chunk_index": int(chunk_index),
            "status": "pending",
            "video_time_offset": float(video_time_offset),
            "video_time_end": float(video_time_end),
            "text": "",
            "words": [],
            "gloss": [],
            "clips": [],
            "speaker_label": None,
            "error": None,
            "source_key": source_key,
            "created_at": now,
        }
        self._save_live_state(state)

        try:
            response = self.http.post(
                "https://api.assemblyai.com/v2/transcript",
                headers={"authorization": self.assemblyai_key},
                json={
                    "audio_url": audio_url,
                    "punctuate": True,
                    "format_text": True,
                    "speaker_labels": True,
                },
                timeout=30,
            )
            response.raise_for_status()
            state["transcript_id"] = response.json()["id"]
            self._save_live_state(state)
        except Exception as exc:
            state.update({"status": "error", "error": str(exc)})
            self._save_live_state(state)
            self._refresh_live_summary(video_id, title=title, latest_error=str(exc))
            raise

        self._refresh_live_summary(
            video_id,
            title=title,
            duration=video_time_end,
        )
        return self._public_live_state(state)

    def get_live_session(
        self,
        session_id: str,
        *,
        advance: bool = False,
    ) -> list[dict[str, Any]]:
        states = [
            self._get_json(key)
            for key in self._list_keys(self._live_prefix(session_id))
        ]
        states = [state for state in states if state]
        states.sort(key=lambda item: int(item.get("chunk_index") or 0))

        if advance:
            advanced = 0
            for index, state in enumerate(states):
                if state.get("status") != "pending" or advanced >= self.batch_size:
                    continue
                states[index] = self._advance_live_chunk(state)
                advanced += 1

        return [self._public_live_state(state) for state in states]

    def _advance_live_chunk(self, state: dict[str, Any]) -> dict[str, Any]:
        transcript_id = state.get("transcript_id")
        if not transcript_id:
            state.update(
                {
                    "status": "error",
                    "error": "Caption chunk is missing its AssemblyAI transcript ID",
                }
            )
            self._save_live_state(state)
            self._refresh_live_summary(
                state["video_id"], latest_error=state["error"]
            )
            return state

        response = self.http.get(
            f"https://api.assemblyai.com/v2/transcript/{transcript_id}",
            headers={"authorization": self.assemblyai_key},
            timeout=30,
        )
        response.raise_for_status()
        payload = response.json()
        transcript_status = payload.get("status")
        if transcript_status == "error":
            state.update(
                {
                    "status": "error",
                    "error": payload.get("error", "AssemblyAI transcription failed"),
                }
            )
            self._save_live_state(state)
            self._refresh_live_summary(
                state["video_id"], latest_error=state["error"]
            )
            return state
        if transcript_status != "completed":
            return state

        words = []
        for word in payload.get("words") or []:
            normalized = {
                "text": word["text"],
                "start": word["start"],
                "end": word["end"],
            }
            if word.get("speaker") is not None:
                normalized["speaker"] = word["speaker"]
            words.append(normalized)

        text = str(payload.get("text") or "").strip()
        if not text:
            state.update({"status": "empty", "text": "", "words": words})
            self._save_live_state(state)
            self._refresh_live_summary(
                state["video_id"],
                duration=state.get("video_time_end"),
                completed=True,
            )
            return state

        start = float(state.get("video_time_offset") or 0)
        end = float(state.get("video_time_end") or 0)
        duration = end - start
        if duration <= 0:
            duration = max(0.1, float(words[-1]["end"]) / 1000) if words else 10.0
            end = start + duration

        gloss, clips = self.caption_builder(text, words, duration)
        utterances = payload.get("utterances") or []
        speaker_label = utterances[0].get("speaker") if utterances else None
        if speaker_label is None and words:
            speaker_label = words[0].get("speaker")

        state.update(
            {
                "status": "ready",
                "video_time_end": end,
                "text": text,
                "words": words,
                "gloss": gloss,
                "clips": clips,
                "speaker_label": speaker_label,
                "error": None,
            }
        )
        self._save_live_state(state)
        self._merge_live_caption(state)
        self._refresh_live_summary(state["video_id"], duration=end)
        return state

    def _merge_live_caption(self, caption: dict[str, Any]) -> None:
        video_id = caption["video_id"]
        captions = self.get_video(video_id)
        identity = (caption["session_id"], int(caption["chunk_index"]))
        by_identity = {
            (item.get("session_id"), int(item.get("chunk_index") or 0)): item
            for item in captions
        }
        by_identity[identity] = self._public_live_state(caption)
        merged = sorted(
            by_identity.values(),
            key=lambda item: (
                float(item.get("video_time_offset") or 0),
                str(item.get("session_id") or ""),
                int(item.get("chunk_index") or 0),
            ),
        )
        self._put_json(self._captions_key(video_id), merged)

    def _refresh_live_summary(
        self,
        video_id: str,
        *,
        title: str | None = None,
        duration: float | None = None,
        latest_error: str | None = None,
        completed: bool = False,
    ) -> None:
        captions = self.get_video(video_id)
        previous = self._get_json(self._state_key(video_id), {})
        clean_title = str(title or "").strip()[:300]
        previous_title = str(previous.get("title") or "").strip()
        resolved_title = clean_title or previous_title or f"YouTube video {video_id}"
        max_end = max(
            [float(item.get("video_time_end") or 0) for item in captions]
            + [float(duration or 0), float(previous.get("duration") or 0)]
        )
        has_captions = bool(captions)
        is_ready = has_captions or completed
        status = "ready" if is_ready else ("error" if latest_error else "preparing")
        summary = {
            "video_id": video_id,
            "status": status,
            "stage": "ready" if is_ready else ("error" if latest_error else "transcribing"),
            "progress": 100 if is_ready else 40,
            "error": None if is_ready else latest_error,
            "title": resolved_title,
            "duration": max_end,
            "created_at": previous.get("created_at") or time.time(),
            "source": "extension",
            "chunk_count": len(captions),
            "sign_count": sum(len(item.get("clips") or []) for item in captions),
            "transcript_preview": " ".join(
                item.get("text", "").strip() for item in captions[:2]
            )[:240],
        }
        self._save_state(summary)

    def find_covering(
        self,
        video_id: str,
        session_id: str,
        start: float,
        end: float,
        *,
        min_overlap: float = 0.9,
    ) -> dict[str, Any] | None:
        span = end - start
        if span <= 0:
            return None
        for caption in self.get_video(video_id):
            if caption.get("session_id") == session_id or caption.get("status") != "ready":
                continue
            caption_start = float(caption.get("video_time_offset") or 0)
            caption_end = float(caption.get("video_time_end") or 0)
            overlap = max(0.0, min(end, caption_end) - max(start, caption_start))
            if overlap / span >= min_overlap:
                return caption
        return None

    def get_prepared(self, video_id: str, *, advance: bool = False) -> dict[str, Any]:
        state = self._get_json(self._state_key(video_id))
        if state and advance and state.get("status") == "preparing":
            state = self._advance(state)
        return self._public_state(state, video_id)

    def _advance(self, state: dict[str, Any]) -> dict[str, Any]:
        video_id = state["video_id"]
        stage = state.get("stage")

        if stage == "transcribing":
            transcript_id = state.get("transcript_id")
            if not transcript_id:
                self.mark_error(
                    video_id,
                    "Preparation job is missing its AssemblyAI transcript ID",
                )
                return self._get_json(self._state_key(video_id))

            response = self.http.get(
                f"https://api.assemblyai.com/v2/transcript/{transcript_id}",
                headers={"authorization": self.assemblyai_key},
                timeout=30,
            )
            response.raise_for_status()
            payload = response.json()
            transcript_status = payload.get("status")
            if transcript_status == "error":
                self.mark_error(
                    video_id,
                    payload.get("error", "AssemblyAI transcription failed"),
                )
                return self._get_json(self._state_key(video_id))
            if transcript_status != "completed":
                return state

            words = [
                {"text": word["text"], "start": word["start"], "end": word["end"]}
                for word in (payload.get("words") or [])
            ]
            if not words:
                self.mark_error(
                    video_id,
                    "AssemblyAI completed but returned no transcript words",
                )
                return self._get_json(self._state_key(video_id))

            segments = [
                {"offset": offset, "end": end, "text": text, "words": bucket}
                for offset, end, text, bucket in self.segmenter(words)
            ]
            self._put_json(self._segments_key(video_id), segments)
            self._put_json(self._captions_key(video_id), [])
            state.update(
                {
                    "stage": "matching_signs",
                    "progress": 70,
                    "next_segment": 0,
                    "total_segments": len(segments),
                }
            )
            self._save_state(state)

        if state.get("stage") == "matching_signs":
            state = self._match_next_batch(state)

        return state

    def _match_next_batch(self, state: dict[str, Any]) -> dict[str, Any]:
        video_id = state["video_id"]
        segments = self._get_json(self._segments_key(video_id), [])
        captions = self._get_json(self._captions_key(video_id), [])
        by_index = {int(item["chunk_index"]): item for item in captions}

        start = max(0, int(state.get("next_segment", 0)))
        stop = min(len(segments), start + self.batch_size)
        session_id = f"pre-{video_id}"
        for index in range(start, stop):
            segment = segments[index]
            duration = max(0.1, float(segment["end"]) - float(segment["offset"]))
            gloss, clips = self.caption_builder(
                segment["text"], segment["words"], duration
            )
            by_index[index] = {
                "video_id": video_id,
                "session_id": session_id,
                "chunk_index": index,
                "status": "ready",
                "video_time_offset": segment["offset"],
                "video_time_end": segment["end"],
                "text": segment["text"],
                "words": segment["words"],
                "gloss": gloss,
                "clips": clips,
                "error": None,
            }

        captions = [by_index[index] for index in sorted(by_index)]
        self._put_json(self._captions_key(video_id), captions)

        total = len(segments)
        next_segment = stop
        state["next_segment"] = next_segment
        if next_segment >= total:
            state.update(
                {
                    "status": "ready",
                    "stage": "ready",
                    "progress": 100,
                    "chunk_count": len(captions),
                    "sign_count": sum(len(item.get("clips") or []) for item in captions),
                    "transcript_preview": " ".join(
                        item.get("text", "").strip() for item in captions[:2]
                    )[:240],
                }
            )
        else:
            state["progress"] = 70 + round((next_segment / max(1, total)) * 29)
        self._save_state(state)
        return state

    def get_video(self, video_id: str) -> list[dict[str, Any]]:
        return self._get_json(self._captions_key(video_id), [])

    def list_prepared(self, limit: int = 50) -> list[dict[str, Any]]:
        safe_limit = max(1, min(int(limit), 100))
        prefix = f"{self.prefix}/prepared/"
        keys = self._list_keys(prefix)

        states = [self._get_json(key) for key in keys]
        states = [state for state in states if state]
        states.sort(key=lambda item: float(item.get("created_at") or 0), reverse=True)

        results = []
        for state in states[:safe_limit]:
            video_id = state["video_id"]
            results.append(
                {
                    "video_id": video_id,
                    "session_id": f"pre-{video_id}",
                    "title": state.get("title") or f"YouTube video {video_id}",
                    "status": state.get("status"),
                    "error": state.get("error"),
                    "created_at": state.get("created_at"),
                    "duration": state.get("duration") or 0,
                    "chunk_count": state.get("chunk_count") or 0,
                    "sign_count": state.get("sign_count") or 0,
                    "transcript_preview": state.get("transcript_preview") or "",
                }
            )
        return results

    def delete_prepared(self, video_id: str) -> dict[str, Any]:
        state = self._get_json(self._state_key(video_id))
        if state is None:
            return {"deleted": False, "reason": "not_found"}
        if state.get("status") == "preparing":
            return {"deleted": False, "reason": "preparing"}

        captions = self.get_video(video_id)
        keys = [
            self._state_key(video_id),
            self._segments_key(video_id),
            self._captions_key(video_id),
        ]
        if state.get("source_key"):
            keys.append(state["source_key"])

        for key in self._list_keys(self._live_prefix()):
            live_state = self._get_json(key)
            if live_state and live_state.get("video_id") == video_id:
                keys.append(key)
                if live_state.get("source_key"):
                    keys.append(live_state["source_key"])

        keys.extend(self._list_keys(f"{video_id}/"))
        unique_keys = list(dict.fromkeys(keys))
        for start in range(0, len(unique_keys), 1000):
            batch = unique_keys[start : start + 1000]
            self.s3.delete_objects(
                Bucket=self.bucket,
                Delete={"Objects": [{"Key": key} for key in batch], "Quiet": True},
            )
        return {"deleted": True, "captions_deleted": len(captions)}
