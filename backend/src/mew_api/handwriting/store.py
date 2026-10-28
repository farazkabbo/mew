"""Where handwriting samples are kept (migration 20261110000000_handwriting.sql).

The student's own token reads and writes them (RLS). Each student keeps at most SAMPLES_PER_USER;
adding more removes the oldest. Local mode keeps them in memory.
"""

import threading
import time
from datetime import datetime
from typing import Any, Protocol

from ..supabase_rest import SupabaseRest
from .models import SAMPLES_PER_USER, Sample, SampleInput


def _row(s: SampleInput) -> dict[str, Any]:
    return {
        "id": str(s.id),
        "text": s.text,
        "latex": s.latex,
        "read_as": s.read_as,
        "source": s.source,
        "image": s.image,
    }


def _millis(created: object) -> int:
    if isinstance(created, int):
        return created
    return int(datetime.fromisoformat(str(created)).timestamp() * 1000)


def _sample(row: dict[str, Any]) -> Sample:
    return Sample(
        id=row["id"],
        text=row["text"],
        latex=row["latex"],
        read_as=row["read_as"],
        source=row["source"],
        image=row["image"],
        created_at=_millis(row["created_at"]),
    )


class HandwritingStore(Protocol):
    def all(self, user: str) -> list[Sample]: ...
    def add(self, user: str, samples: list[SampleInput]) -> int: ...
    def delete_all(self, user: str) -> int: ...


class MemoryHandwritingStore:
    def __init__(self) -> None:
        self._rows: dict[str, list[dict[str, Any]]] = {}
        self._lock = threading.Lock()

    def all(self, user: str) -> list[Sample]:
        with self._lock:
            rows = list(self._rows.get(user, []))
        return [_sample(r) for r in sorted(rows, key=lambda r: r["created_at"], reverse=True)]

    def add(self, user: str, samples: list[SampleInput]) -> int:
        now = int(time.time() * 1000)
        with self._lock:
            rows = self._rows.setdefault(user, [])
            ids = {r["id"] for r in rows}
            fresh = [
                {**_row(s), "created_at": now + i}
                for i, s in enumerate(samples)
                if str(s.id) not in ids
            ]
            rows.extend(fresh)
            rows.sort(key=lambda r: r["created_at"], reverse=True)
            del rows[SAMPLES_PER_USER:]
        return len(fresh)

    def delete_all(self, user: str) -> int:
        with self._lock:
            return len(self._rows.pop(user, []))


class SupabaseHandwritingStore(SupabaseRest):
    def all(self, user: str) -> list[Sample]:
        rows = self._get(
            "handwriting_samples",
            {"user_id": f"eq.{user}", "order": "created_at.desc", "limit": str(SAMPLES_PER_USER)},
        )
        return [_sample(r) for r in rows]

    def add(self, user: str, samples: list[SampleInput]) -> int:
        self._request(
            "POST",
            "/rest/v1/handwriting_samples",
            params={"on_conflict": "id"},
            json=[self._owned(user, _row(s)) for s in samples],
            headers={"Prefer": "resolution=ignore-duplicates,return=minimal"},
        )
        # Keep the newest SAMPLES_PER_USER.
        old = self._get(
            "handwriting_samples",
            {
                "select": "id",
                "user_id": f"eq.{user}",
                "order": "created_at.desc",
                "offset": str(SAMPLES_PER_USER),
                "limit": "200",
            },
        )
        if old:
            ids = ",".join(str(r["id"]) for r in old)
            self._delete("handwriting_samples", {"user_id": f"eq.{user}", "id": f"in.({ids})"})
        return len(samples)

    def delete_all(self, user: str) -> int:
        count = len(self._get("handwriting_samples", {"select": "id", "user_id": f"eq.{user}"}))
        self._delete("handwriting_samples", {"user_id": f"eq.{user}"})
        return count
