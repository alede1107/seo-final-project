"""Personal ASL clip metadata for stateless production runtimes.

Local development keeps clip metadata in SQLite (see `pipeline.py`); Vercel and
other stateless runtimes use this store so a user's personal clips survive across
processes. Only *metadata* lives here — the clip media is put to S3 by `app.py`
for both paths (mirroring how caption media is always S3 but caption rows split
SQLite vs `cloud_prepared`). Keyed `personal/{user_id}/clips.json`.
"""

from __future__ import annotations

import json
import time
from typing import Any

from botocore.exceptions import ClientError


class PersonalClipStore:
    def __init__(self, s3_client, bucket: str, *, prefix: str = "captionaid/v2"):
        self.s3 = s3_client
        self.bucket = bucket
        self.prefix = prefix.strip("/")

    def _clips_key(self, user_id: str) -> str:
        return f"{self.prefix}/personal/{user_id}/clips.json"

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
        return json.loads(response["Body"].read().decode("utf-8"))

    def _load(self, user_id: str) -> list[dict[str, Any]]:
        return self._get_json(self._clips_key(user_id), []) or []

    def _save(self, user_id: str, clips: list[dict[str, Any]]) -> None:
        self._put_json(self._clips_key(user_id), clips)

    def add_personal_clip(
        self, user_id, word, s3_key, mime, clip_id, preferred=False
    ) -> dict[str, Any]:
        clips = [c for c in self._load(user_id) if c.get("clip_id") != clip_id]
        record = {
            "clip_id": clip_id,
            "user_id": user_id,
            "word": word,
            "s3_key": s3_key,
            "mime": mime,
            "preferred": bool(preferred),
            "created_at": time.time(),
        }
        clips.append(record)
        self._save(user_id, clips)
        return record

    def list_personal_clips(self, user_id) -> list[dict[str, Any]]:
        if not user_id:
            return []
        clips = self._load(user_id)
        clips.sort(key=lambda c: c.get("created_at") or 0, reverse=True)
        return clips

    def get_personal_clip(self, user_id, clip_id) -> dict[str, Any] | None:
        for clip in self._load(user_id):
            if clip.get("clip_id") == clip_id:
                return clip
        return None

    def set_preferred(self, user_id, clip_id) -> dict[str, Any] | None:
        clips = self._load(user_id)
        target = next((c for c in clips if c.get("clip_id") == clip_id), None)
        if target is None:
            return None
        word = target.get("word")
        for clip in clips:
            if clip.get("word") == word:
                clip["preferred"] = clip.get("clip_id") == clip_id
        self._save(user_id, clips)
        return target

    def delete_personal_clip(self, user_id, clip_id) -> dict[str, Any] | None:
        clips = self._load(user_id)
        target = next((c for c in clips if c.get("clip_id") == clip_id), None)
        if target is None:
            return None
        self._save(user_id, [c for c in clips if c.get("clip_id") != clip_id])
        return target
