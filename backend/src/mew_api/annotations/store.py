"""Where live annotations are kept (migration 20261105000000_annotations.sql).

The student's own token writes them (RLS), as an upsert by id: a mark is sent again when it
resolves or is dismissed. Local mode keeps them in memory.
"""

import threading
from datetime import UTC, datetime
from typing import Any, Protocol

from ..supabase_rest import SupabaseRest
from .models import AnnotationUpsert


def _when(millis: int | None) -> str | None:
    return None if millis is None else datetime.fromtimestamp(millis / 1000, UTC).isoformat()


def annotation_row(a: AnnotationUpsert) -> dict[str, Any]:
    return {
        "id": str(a.id),
        "page_id": str(a.page_id),
        "line_id": str(a.line_id),
        "mark_kind": a.mark_kind,
        "verdict": a.verdict,
        "checker_method": a.checker_method,
        "recognized_text": a.recognized_text,
        "confidence": a.confidence,
        "stroke_group_id": str(a.stroke_group_id),
        "note": a.note,
        "created_at": _when(a.created_at),
        "resolved_at": _when(a.resolved_at),
        "dismissed_as": a.dismissed_as,
        "evidence": a.evidence,
    }


class AnnotationStore(Protocol):
    def upsert(self, user: str, annotations: list[AnnotationUpsert]) -> int: ...


class MemoryAnnotationStore:
    def __init__(self) -> None:
        self._rows: dict[tuple[str, str], dict[str, Any]] = {}
        self._lock = threading.Lock()

    def upsert(self, user: str, annotations: list[AnnotationUpsert]) -> int:
        saved = 0
        with self._lock:
            for annotation in annotations:
                row = annotation_row(annotation)
                key = (user, row["id"])
                before = self._rows.get(key)
                fixed = ("page_id", "line_id", "stroke_group_id", "created_at")
                if before and any(before[k] != row[k] for k in fixed):
                    continue  # a mark stays on its page and line (the database's trigger)
                self._rows[key] = row
                saved += 1
        return saved

    def rows(self, user: str) -> list[dict[str, Any]]:
        with self._lock:
            return [dict(r) for (owner, _), r in self._rows.items() if owner == user]


class SupabaseAnnotationStore(SupabaseRest):
    def upsert(self, user: str, annotations: list[AnnotationUpsert]) -> int:
        rows = [self._owned(user, annotation_row(a)) for a in annotations]
        self._request(
            "POST",
            "/rest/v1/annotations",
            params={"on_conflict": "id"},
            json=rows,
            headers={"Prefer": "resolution=merge-duplicates,return=minimal"},
        )
        return len(rows)
