"""Where logged gate decisions live: mew_events in Supabase (RLS: own rows, and inserts only with
the owner's opt-in), or memory in local mode."""

import threading
import uuid
from datetime import UTC, datetime
from typing import Any, Protocol
from uuid import UUID

from ..supabase_rest import SupabaseRest
from .models import MAX_LOCAL_EVENTS, MewEvent, MewLabel


class MewEventStore(Protocol):
    def add_event(self, user: str, input: dict[str, Any], output: dict[str, Any]) -> bool:
        """Keeps one decision; False if the database refused it (no opt-in)."""
        ...

    def list_events(
        self, user: str, *, unlabeled_only: bool, before: datetime | None, limit: int
    ) -> list[MewEvent]:
        """Newest first."""
        ...

    def labeled_events(self, user: str, limit: int) -> list[MewEvent]: ...
    def label_event(self, user: str, event_id: UUID, label: MewLabel | None) -> bool: ...
    def delete_events(self, user: str) -> None: ...


class MemoryMewEventStore:
    def __init__(self) -> None:
        self._events: dict[str, list[MewEvent]] = {}
        self._lock = threading.Lock()

    def add_event(self, user: str, input: dict[str, Any], output: dict[str, Any]) -> bool:
        event = MewEvent(
            id=uuid.uuid4(),
            input=input,
            output=output,
            human_label=None,
            created_at=datetime.now(UTC),
        )
        with self._lock:
            events = self._events.setdefault(user, [])
            events.append(event)
            del events[:-MAX_LOCAL_EVENTS]
        return True

    def list_events(
        self, user: str, *, unlabeled_only: bool, before: datetime | None, limit: int
    ) -> list[MewEvent]:
        with self._lock:
            events = list(reversed(self._events.get(user, [])))
        return [
            e
            for e in events
            if (not unlabeled_only or e.human_label is None)
            and (before is None or e.created_at < before)
        ][:limit]

    def labeled_events(self, user: str, limit: int) -> list[MewEvent]:
        with self._lock:
            return [e for e in self._events.get(user, []) if e.human_label is not None][-limit:]

    def label_event(self, user: str, event_id: UUID, label: MewLabel | None) -> bool:
        with self._lock:
            events = self._events.get(user, [])
            for i, event in enumerate(events):
                if event.id == event_id:
                    events[i] = event.model_copy(update={"human_label": label})
                    return True
        return False

    def delete_events(self, user: str) -> None:
        with self._lock:
            self._events.pop(user, None)


class SupabaseMewEventStore(SupabaseRest):
    """mew_events through PostgREST with the user's token."""

    _SELECT = "id,input,output,human_label,created_at"

    def add_event(self, user: str, input: dict[str, Any], output: dict[str, Any]) -> bool:
        try:
            self._insert("mew_events", [{"input": input, "output": output}], returning=False)
        except PermissionError:
            return False  # RLS: the profile hasn't opted in
        return True

    def list_events(
        self, user: str, *, unlabeled_only: bool, before: datetime | None, limit: int
    ) -> list[MewEvent]:
        params = {
            "user_id": f"eq.{user}",
            "select": self._SELECT,
            "order": "created_at.desc",
            "limit": str(limit),
        }
        if unlabeled_only:
            params["human_label"] = "is.null"
        if before is not None:
            params["created_at"] = f"lt.{before.astimezone(UTC).strftime('%Y-%m-%dT%H:%M:%S.%fZ')}"
        return [MewEvent.model_validate(r) for r in self._get("mew_events", params)]

    def labeled_events(self, user: str, limit: int) -> list[MewEvent]:
        rows = self._get(
            "mew_events",
            {
                "user_id": f"eq.{user}",
                "human_label": "not.is.null",
                "select": self._SELECT,
                "order": "created_at.desc",
                "limit": str(limit),
            },
        )
        return [MewEvent.model_validate(r) for r in reversed(rows)]

    def label_event(self, user: str, event_id: UUID, label: MewLabel | None) -> bool:
        rows = self._patch(
            "mew_events",
            {"user_id": f"eq.{user}", "id": f"eq.{event_id}"},
            {"human_label": label},
        )
        return bool(rows)

    def delete_events(self, user: str) -> None:
        self._delete("mew_events", {"user_id": f"eq.{user}"})
