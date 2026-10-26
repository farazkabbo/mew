"""The explanation's own voice, kept for Replay (K8 §4.7: "Replay … with the original voice").

The student's page uploads what it played (16-bit PCM at 24 kHz, a clip per step) with their own
Clerk token, into "<user id>/<clip id>/<turn>-<step>.pcm" of the private moment-audio bucket; it
reads them back the same way. Up to about 60 seconds an entry: replaying costs nothing and sounds
the same.
"""

import threading
from typing import Protocol
from urllib.parse import quote
from uuid import UUID

from ..supabase_rest import SupabaseRest

BUCKET = "moment-audio"
#: One step's clip (≈ 20 s of 24 kHz 16-bit mono).
MAX_CLIP_BYTES = 1_000_000
#: A whole entry's voice (≈ 60 s).
MAX_ENTRY_BYTES = 2_900_000
MEDIA_TYPE = "audio/L16"


def audio_path(user: str, clip_id: UUID, turn: int, step: int) -> str:
    return f"{user}/{clip_id}/{turn}-{step}.pcm"


class AudioStore(Protocol):
    def put(self, user: str, clip_id: UUID, turn: int, step: int, pcm: bytes) -> None: ...
    def get(self, user: str, clip_id: UUID, turn: int, step: int) -> bytes | None: ...


class MemoryAudioStore:
    def __init__(self) -> None:
        self._clips: dict[str, bytes] = {}
        self._lock = threading.Lock()

    def put(self, user: str, clip_id: UUID, turn: int, step: int, pcm: bytes) -> None:
        with self._lock:
            prefix = f"{user}/{clip_id}/"
            total = sum(len(v) for k, v in self._clips.items() if k.startswith(prefix))
            if total + len(pcm) > MAX_ENTRY_BYTES:
                raise ValueError("too much audio for one entry")
            self._clips[audio_path(user, clip_id, turn, step)] = pcm

    def get(self, user: str, clip_id: UUID, turn: int, step: int) -> bytes | None:
        with self._lock:
            return self._clips.get(audio_path(user, clip_id, turn, step))


class SupabaseAudioStore(SupabaseRest):
    """With the student's token: the bucket's folder policies apply (their own folder only)."""

    def put(self, user: str, clip_id: UUID, turn: int, step: int, pcm: bytes) -> None:
        if self.service:
            raise PermissionError("the student's page uploads their own audio")
        path = quote(audio_path(user, clip_id, turn, step))
        self._request(
            "POST",
            f"/storage/v1/object/{BUCKET}/{path}",
            content=pcm,
            headers={"Content-Type": MEDIA_TYPE, "x-upsert": "true"},
        )

    def get(self, user: str, clip_id: UUID, turn: int, step: int) -> bytes | None:
        path = quote(audio_path(user, clip_id, turn, step))
        response = self._request(
            "GET", f"/storage/v1/object/authenticated/{BUCKET}/{path}", ok=(400, 404)
        )
        return None if response.is_error else response.content
