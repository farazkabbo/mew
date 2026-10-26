"""Where clips live: Supabase (a row in public.clips plus a JPEG in the private "clips" bucket),
or, in local development mode, this process's memory.

Creating uses the secret key (the desktop app has no Clerk session), only after the route has
verified the device token, and always sets user_id and the user's own folder. Reading, noting
the notebook page and deleting use the owner's Clerk token, so RLS and the bucket policies
apply.

A Circle & Ask entry (S3.2) is a clip with `kind` "entry": its session, the student's marks, and
its turns; a follow-up in the same session is appended to it (`append`, also with the secret
key after the device check), within the same caps on ink as any clip.
"""

import threading
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Protocol
from urllib.parse import quote
from uuid import UUID

from ..supabase_rest import StoreError, SupabaseRest
from .models import (
    MAX_POINTS,
    MAX_STROKES,
    MAX_TURNS,
    ClipCreate,
    ClipView,
    EntryAppend,
    SavedDestination,
)

BUCKET = "clips"


def storage_path(user: str, clip_id: UUID) -> str:
    return f"{user}/{clip_id}.jpg"


class ClipWriter(Protocol):
    def create(self, user: str, clip_id: UUID, clip: ClipCreate, image: bytes) -> None: ...

    def append(self, user: str, entry: EntryAppend) -> UUID | None:
        """Adds a follow-up to the session's entry; its clip id, or None if there's no such entry.
        Raises `EntryFullError` if it would go over the caps."""
        ...

    def set_destination(self, user: str, clip_id: UUID, destination: SavedDestination) -> bool:
        """Where the user's clip goes in the notebook (K3); False if they have no such clip."""
        ...


class EntryFullError(ValueError):
    """An entry has as many turns, strokes or points as a clip may hold."""


class ClipReader(Protocol):
    def get(self, user: str, clip_id: UUID) -> ClipView | None: ...
    def set_page(self, user: str, clip_id: UUID, page_id: UUID) -> ClipView | None: ...
    def delete(self, user: str, clip_id: UUID) -> bool: ...
    def image(self, user: str, clip_id: UUID) -> bytes | None: ...


def _row(user: str, clip_id: UUID, clip: ClipCreate) -> dict[str, Any]:
    source = clip.source
    return {
        "id": str(clip_id),
        "user_id": user,
        "storage_path": storage_path(user, clip_id),
        "width": clip.image.width,
        "height": clip.image.height,
        "pixel_ratio": clip.pixel_ratio,
        "source_app": source.app,
        "source_title": source.title,
        "source_url": source.url,
        "source_timestamp_sec": source.timestamp_sec,
        "annotations": [s.model_dump(mode="json") for s in clip.strokes],
        "ocr_text": clip.ocr_text,
        "captured_at": source.captured_at.isoformat(),
        "destination": _destination_column(clip.destination),
        **_entry_columns(clip),
    }


def _destination_column(destination: SavedDestination | None) -> dict[str, Any] | None:
    return (
        None
        if destination is None
        else destination.model_dump(mode="json", by_alias=True, exclude_none=True)
    )


def _entry_columns(clip: ClipCreate) -> dict[str, Any]:
    """An entry's own columns (an ordinary clip has the defaults)."""
    entry = clip.entry
    if entry is None:
        return {"kind": "clip"}
    return {
        "kind": "entry",
        "session_id": str(entry.session_id),
        "student_strokes": [s.model_dump(mode="json") for s in entry.student_strokes],
        "entry": {
            "turns": [entry.turn.model_dump(mode="json", by_alias=True, exclude_none=True)],
            "strokeSteps": [[0, step] for step in entry.stroke_steps],
            "conceptHints": entry.concept_hints,
        },
    }


def _appended(row: dict[str, Any], entry: EntryAppend) -> dict[str, Any]:
    """The row's changed columns once `entry` is added (EntryFullError over the caps)."""
    stored = row.get("entry") or {"turns": [], "strokeSteps": [], "conceptHints": []}
    turns = [*stored["turns"], entry.turn.model_dump(mode="json", by_alias=True, exclude_none=True)]
    annotations = [*row["annotations"], *(s.model_dump(mode="json") for s in entry.strokes)]
    points = sum(len(s["points"]) for s in annotations)
    points += sum(len(s["points"]) for s in row.get("student_strokes") or [])
    if len(turns) > MAX_TURNS or len(annotations) > MAX_STROKES or points > MAX_POINTS:
        raise EntryFullError("the entry is full")
    turn = len(turns) - 1
    hints = list(dict.fromkeys([*stored["conceptHints"], *entry.concept_hints]))[:5]
    return {
        "annotations": annotations,
        "entry": {
            "turns": turns,
            "strokeSteps": [*stored["strokeSteps"], *([turn, s] for s in entry.stroke_steps)],
            "conceptHints": hints,
        },
    }


def _view(row: dict[str, Any]) -> ClipView:
    return ClipView.model_validate(
        {
            "id": row["id"],
            "width": row["width"],
            "height": row["height"],
            "pixel_ratio": row["pixel_ratio"],
            "strokes": row["annotations"],
            "source": {
                "app": row["source_app"],
                "title": row.get("source_title"),
                "url": row.get("source_url"),
                "timestamp_sec": row.get("source_timestamp_sec"),
                "captured_at": row["captured_at"],
            },
            "ocr_text": row["ocr_text"],
            "notebook_page_id": row.get("notebook_page_id"),
            "created_at": row["created_at"],
            "entry": _entry_view(row),
            "destination": row.get("destination"),
        }
    )


def _entry_view(row: dict[str, Any]) -> dict[str, Any] | None:
    entry = row.get("entry")
    if row.get("kind") != "entry" or not entry:
        return None
    return {
        "session_id": row["session_id"],
        "student_strokes": row.get("student_strokes") or [],
        "turns": entry["turns"],
        "stroke_steps": entry["strokeSteps"],
        "concept_hints": entry["conceptHints"],
    }


# ─── Local mode ──────────────────────────────────────────────────────────────────────────────


@dataclass
class _Stored:
    row: dict[str, Any]
    image: bytes = field(repr=False)


class MemoryClipStore:
    """Clips per user in memory (development only), isolated like RLS."""

    def __init__(self) -> None:
        self._clips: dict[tuple[str, UUID], _Stored] = {}
        self._lock = threading.Lock()

    def create(self, user: str, clip_id: UUID, clip: ClipCreate, image: bytes) -> None:
        row = _row(user, clip_id, clip) | {
            "notebook_page_id": None,
            "created_at": datetime.now(UTC).isoformat(),
        }
        with self._lock:
            self._clips[(user, clip_id)] = _Stored(row, image)

    def append(self, user: str, entry: EntryAppend) -> UUID | None:
        with self._lock:
            for (owner, clip_id), stored in self._clips.items():
                if owner == user and stored.row.get("session_id") == str(entry.session_id):
                    stored.row.update(_appended(stored.row, entry))
                    return clip_id
        return None

    def set_destination(self, user: str, clip_id: UUID, destination: SavedDestination) -> bool:
        with self._lock:
            stored = self._clips.get((user, clip_id))
            if stored is None:
                return False
            stored.row["destination"] = _destination_column(destination)
            return True

    def get(self, user: str, clip_id: UUID) -> ClipView | None:
        with self._lock:
            stored = self._clips.get((user, clip_id))
            return _view(stored.row) if stored else None

    def set_page(self, user: str, clip_id: UUID, page_id: UUID) -> ClipView | None:
        with self._lock:
            stored = self._clips.get((user, clip_id))
            if stored is None:
                return None
            stored.row["notebook_page_id"] = str(page_id)
            return _view(stored.row)

    def delete(self, user: str, clip_id: UUID) -> bool:
        with self._lock:
            return self._clips.pop((user, clip_id), None) is not None

    def image(self, user: str, clip_id: UUID) -> bytes | None:
        with self._lock:
            stored = self._clips.get((user, clip_id))
            return stored.image if stored else None


# ─── Supabase ────────────────────────────────────────────────────────────────────────────────


class SupabaseClipWriter(SupabaseRest):
    """Creates clips with the secret key (service mode): upload first, then the row; if the row
    fails, the upload is removed so no orphan image is left behind."""

    def create(self, user: str, clip_id: UUID, clip: ClipCreate, image: bytes) -> None:
        if not self.service:
            raise PermissionError("clips are created by the service")
        path = storage_path(user, clip_id)
        self._request(
            "POST",
            f"/storage/v1/object/{BUCKET}/{quote(path)}",
            content=image,
            headers={"Content-Type": "image/jpeg", "x-upsert": "false"},
        )
        try:
            self._insert("clips", [_row(user, clip_id, clip)], returning=False)
        except (PermissionError, StoreError):
            self._request(
                "DELETE", f"/storage/v1/object/{BUCKET}", json={"prefixes": [path]}, ok=(200, 404)
            )
            raise

    def append(self, user: str, entry: EntryAppend) -> UUID | None:
        if not self.service:
            raise PermissionError("entries are written by the service")
        rows = self._get(
            "clips",
            {
                "select": "id,annotations,student_strokes,entry,revision",
                "user_id": f"eq.{user}",
                "session_id": f"eq.{entry.session_id}",
            },
        )
        if not rows:
            return None
        row = rows[0]
        # Compare-and-set on the revision: two follow-ups can't overwrite each other's ink.
        updated = self._patch(
            "clips",
            {
                "user_id": f"eq.{user}",
                "id": f"eq.{row['id']}",
                "revision": f"eq.{row['revision']}",
            },
            {**_appended(row, entry), "revision": row["revision"] + 1},
        )
        if not updated:
            raise StoreError("the entry changed meanwhile")
        return UUID(row["id"])

    def set_destination(self, user: str, clip_id: UUID, destination: SavedDestination) -> bool:
        if not self.service:
            raise PermissionError("destinations are written by the service")
        rows = self._patch(
            "clips",
            {"user_id": f"eq.{user}", "id": f"eq.{clip_id}"},
            {"destination": _destination_column(destination)},
        )
        return bool(rows)


class SupabaseClipReader(SupabaseRest):
    """The owner's clips, with their Clerk token (RLS and bucket policies apply)."""

    def _one(self, user: str, clip_id: UUID) -> dict[str, Any] | None:
        rows = self._get("clips", {"user_id": f"eq.{user}", "id": f"eq.{clip_id}"})
        return rows[0] if rows else None

    def get(self, user: str, clip_id: UUID) -> ClipView | None:
        row = self._one(user, clip_id)
        return _view(row) if row else None

    def set_page(self, user: str, clip_id: UUID, page_id: UUID) -> ClipView | None:
        rows = self._patch(
            "clips",
            {"user_id": f"eq.{user}", "id": f"eq.{clip_id}"},
            {"notebook_page_id": str(page_id)},
        )
        return _view(rows[0]) if rows else None

    def delete(self, user: str, clip_id: UUID) -> bool:
        row = self._one(user, clip_id)
        if row is None:
            return False
        self._delete("clips", {"user_id": f"eq.{user}", "id": f"eq.{clip_id}"})
        self._request(
            "DELETE",
            f"/storage/v1/object/{BUCKET}",
            json={"prefixes": [row["storage_path"]]},
            ok=(200, 404),
        )
        return True

    def image(self, user: str, clip_id: UUID) -> bytes | None:
        row = self._one(user, clip_id)
        if row is None:
            return None
        response = self._request(
            "GET",
            f"/storage/v1/object/authenticated/{BUCKET}/{quote(row['storage_path'])}",
            ok=(400, 404),
        )
        return response.content if response.is_success else None
