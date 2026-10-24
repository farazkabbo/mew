"""Where walkthroughs are kept: Supabase (`walkthroughs`) or, in local mode, memory.

Only the desktop app writes them, through the web app's server, after its device token was
checked: Supabase is used with the secret key, and every query filters on the device's owner
(`SupabaseRest._owned` sets user_id on every insert).

Updates are compare-and-set on `revision`: two events for one walkthrough (a "done" from the pill
and one by voice, say) can't both apply to the same state.
"""

import threading
import uuid
from datetime import UTC, datetime
from typing import Any, Protocol
from uuid import UUID

from ..supabase_rest import SupabaseRest
from .models import WalkthroughCreate, WalkthroughUpdate, WalkthroughView

#: Walkthroughs "continue where we left off" may pick up.
RESUMABLE = ("active", "paused", "stopped")


class WalkthroughStore(Protocol):
    def create(self, user: str, walkthrough: WalkthroughCreate) -> WalkthroughView: ...

    def get(self, user: str, walkthrough_id: UUID) -> WalkthroughView | None: ...

    def latest_resumable(self, user: str, since: datetime) -> WalkthroughView | None:
        """The most recently touched walkthrough that isn't finished, if touched since `since`."""
        ...

    def update(
        self, user: str, walkthrough_id: UUID, update: WalkthroughUpdate
    ) -> WalkthroughView | None:
        """Writes the progress if the walkthrough is still at `update.revision` (and bumps it);
        None if it isn't (someone else wrote first) or doesn't exist."""
        ...


def _row(update: WalkthroughUpdate | None, now: datetime) -> dict[str, Any]:
    """The progress columns of a row (a new walkthrough's when `update` is None)."""
    if update is None:
        return {"status": "active", "phase": "awaiting", "current_step": 0}
    return {
        "status": update.status,
        "phase": update.phase,
        "current_step": update.current,
        "steps": [step.model_dump(mode="json", by_alias=True) for step in update.steps],
        "hints_used": sum(step.hints for step in update.steps),
        "completed_at": now.isoformat() if update.status == "completed" else None,
        "updated_at": now.isoformat(),
    }


def _view(row: dict[str, Any]) -> WalkthroughView:
    return WalkthroughView.model_validate(
        {
            "id": row["id"],
            "title": row["title"],
            "goal": row["goal"],
            "app": row.get("app_exe_name"),
            "status": row["status"],
            "phase": row["phase"],
            "current": row["current_step"],
            "steps": row["steps"],
            "revision": row["revision"],
            "started_at": row["started_at"],
            "updated_at": row["updated_at"],
            "completed_at": row.get("completed_at"),
        }
    )


def _new_row(walkthrough: WalkthroughCreate) -> dict[str, Any]:
    return {
        "title": walkthrough.title,
        "goal": walkthrough.goal,
        "app_exe_name": walkthrough.app,
        "steps": [step.model_dump(mode="json", by_alias=True) for step in walkthrough.steps],
        "hints_used": sum(step.hints for step in walkthrough.steps),
        **_row(None, datetime.now(UTC)),
    }


# ─── Local mode ──────────────────────────────────────────────────────────────────────────────


class MemoryWalkthroughStore:
    """Walkthroughs per user in memory (development only)."""

    def __init__(self) -> None:
        self._rows: dict[str, dict[UUID, dict[str, Any]]] = {}
        self._lock = threading.Lock()
        # Breaks ties between rows written in the same instant (the clock's resolution).
        self._writes = iter(range(1, 1 << 62))

    def create(self, user: str, walkthrough: WalkthroughCreate) -> WalkthroughView:
        now = datetime.now(UTC).isoformat()
        walkthrough_id = uuid.uuid4()
        row = {
            **_new_row(walkthrough),
            "id": str(walkthrough_id),
            "revision": 0,
            "started_at": now,
            "updated_at": now,
            "completed_at": None,
        }
        with self._lock:
            row["write"] = next(self._writes)
            self._rows.setdefault(user, {})[walkthrough_id] = row
        return _view(row)

    def get(self, user: str, walkthrough_id: UUID) -> WalkthroughView | None:
        with self._lock:
            row = self._rows.get(user, {}).get(walkthrough_id)
            return _view(row) if row else None

    def latest_resumable(self, user: str, since: datetime) -> WalkthroughView | None:
        with self._lock:
            rows = [
                row
                for row in self._rows.get(user, {}).values()
                if row["status"] in RESUMABLE and datetime.fromisoformat(row["updated_at"]) >= since
            ]
            latest = max(rows, key=lambda row: (row["updated_at"], row["write"]), default=None)
            return _view(latest) if latest else None

    def update(
        self, user: str, walkthrough_id: UUID, update: WalkthroughUpdate
    ) -> WalkthroughView | None:
        with self._lock:
            row = self._rows.get(user, {}).get(walkthrough_id)
            if row is None or row["revision"] != update.revision:
                return None
            row.update(_row(update, datetime.now(UTC)), revision=update.revision + 1)
            row["write"] = next(self._writes)
            return _view(row)


# ─── Supabase ────────────────────────────────────────────────────────────────────────────────


class SupabaseWalkthroughStore(SupabaseRest):
    """With the secret key, for a device whose token was just verified (every query filters on
    its owner, and `_owned` sets user_id on the insert)."""

    def create(self, user: str, walkthrough: WalkthroughCreate) -> WalkthroughView:
        [row] = self._insert("walkthroughs", [self._owned(user, _new_row(walkthrough))])
        return _view(row)

    def get(self, user: str, walkthrough_id: UUID) -> WalkthroughView | None:
        rows = self._get("walkthroughs", {"user_id": f"eq.{user}", "id": f"eq.{walkthrough_id}"})
        return _view(rows[0]) if rows else None

    def latest_resumable(self, user: str, since: datetime) -> WalkthroughView | None:
        rows = self._get(
            "walkthroughs",
            {
                "user_id": f"eq.{user}",
                "status": f"in.({','.join(RESUMABLE)})",
                "updated_at": f"gte.{since.isoformat()}",
                "order": "updated_at.desc",
                "limit": "1",
            },
        )
        return _view(rows[0]) if rows else None

    def update(
        self, user: str, walkthrough_id: UUID, update: WalkthroughUpdate
    ) -> WalkthroughView | None:
        rows = self._patch(
            "walkthroughs",
            {
                "user_id": f"eq.{user}",
                "id": f"eq.{walkthrough_id}",
                "revision": f"eq.{update.revision}",
            },
            {**_row(update, datetime.now(UTC)), "revision": update.revision + 1},
        )
        return _view(rows[0]) if rows else None
