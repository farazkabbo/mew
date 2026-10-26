"""Where filing and check questions are kept (K8; migration 20261104000000_moments.sql).

Two stores, like the rest of the API:
- Supabase: with the secret key for the desktop app's calls (after its device token is checked,
  every query filtered to the token's owner, decision 40), or with the student's own Clerk token
  for theirs (RLS applies);
- memory, for local mode.

Texts for filing are the student's own course passages (by the chapter they were imported into)
and the concept hints and summaries of moments already filed: read to score, never logged.
"""

import threading
import uuid
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime, timedelta
from typing import Any, Protocol
from uuid import UUID

from ..clips.models import CheckQuestion
from ..supabase_rest import StoreError, SupabaseRest
from .checks import RecentCard, plan_new_check, room_today
from .filing import Correction, Memory

#: Passages and moments read to file one moment (the newest first).
MAX_PASSAGES = 3000
MAX_MOMENTS = 500
PASSAGE_CHARS = 1200
#: Due checks listed at once.
MAX_DUE = 200


@dataclass
class CheckRow:
    id: UUID
    clip_id: UUID
    node_id: UUID | None
    prompt: str
    kind: str
    choices: list[str]
    answer_key: str
    answer_latex: str | None
    concept_hints: list[str]
    status: str
    due_at: datetime | None
    reps: int
    created_at: datetime
    fsrs_state: dict[str, Any] | None = None
    merged_clip_ids: list[UUID] = field(default_factory=list)
    activated_at: datetime | None = None


class MomentStore(Protocol):
    def filing_inputs(
        self, user: str, source_key: str | None
    ) -> tuple[Memory | None, list[Correction]]: ...
    def node_texts(self, user: str) -> dict[UUID, list[str]]: ...
    def remember(self, user: str, source_key: str, node_id: UUID, corrected: bool) -> None: ...
    def add_correction(
        self, user: str, from_node_id: UUID | None, to_node_id: UUID, hints: list[str]
    ) -> None: ...
    def add_check(
        self,
        user: str,
        clip_id: UUID,
        node_id: UUID | None,
        question: CheckQuestion,
        hints: list[str],
        now: datetime,
    ) -> UUID | None: ...
    def due_checks(self, user: str, now: datetime) -> list[CheckRow]: ...
    def get_check(self, user: str, check_id: UUID) -> CheckRow | None: ...
    def schedule(
        self, user: str, check_id: UUID, fsrs_state: dict[str, Any], due_at: datetime, reps: int
    ) -> bool: ...
    def clear_checks(self, user: str) -> None: ...


def moment_texts(rows: Iterable[Mapping[str, Any]]) -> dict[UUID, list[str]]:
    """The concept hints and summaries of moments filed in each node (clip rows of kind entry)."""
    texts: dict[UUID, list[str]] = {}
    for row in rows:
        destination = row.get("destination") or {}
        entry = row.get("entry") or {}
        try:
            node = UUID(str(destination.get("nodeId")))
        except ValueError:
            continue
        parts = [
            *entry.get("conceptHints", []),
            *(t.get("summary", "") for t in entry.get("turns", [])),
        ]
        texts.setdefault(node, []).append(" ".join(p for p in parts if isinstance(p, str)))
    return texts


def _day_start(now: datetime) -> datetime:
    return now.astimezone(UTC).replace(hour=0, minute=0, second=0, microsecond=0)


# ─── Memory (local mode) ─────────────────────────────────────────────────────────────────────


@dataclass
class _UserMoments:
    memory: dict[str, Memory] = field(default_factory=dict)
    corrections: list[Correction] = field(default_factory=list)
    checks: dict[UUID, CheckRow] = field(default_factory=dict)


class MemoryMomentStore:
    """Local mode: kept in this process. Passages and moments come from the other local stores."""

    def __init__(
        self,
        passages: Callable[[str], dict[UUID, list[str]]],
        moments: Callable[[str], dict[UUID, list[str]]],
    ) -> None:
        self._passages = passages
        self._moments = moments
        self._users: dict[str, _UserMoments] = {}
        self._lock = threading.RLock()

    def _data(self, user: str) -> _UserMoments:
        return self._users.setdefault(user, _UserMoments())

    def filing_inputs(
        self, user: str, source_key: str | None
    ) -> tuple[Memory | None, list[Correction]]:
        with self._lock:
            data = self._data(user)
            memory = data.memory.get(source_key) if source_key else None
            return memory, list(data.corrections[-200:])

    def node_texts(self, user: str) -> dict[UUID, list[str]]:
        texts = {k: list(v) for k, v in self._passages(user).items()}
        for node, items in self._moments(user).items():
            texts.setdefault(node, []).extend(items)
        return texts

    def remember(self, user: str, source_key: str, node_id: UUID, corrected: bool) -> None:
        with self._lock:
            data = self._data(user)
            # A move by the student stays marked as theirs.
            was = data.memory.get(source_key)
            data.memory[source_key] = Memory(node_id, corrected or bool(was and was.corrected))

    def add_correction(
        self, user: str, from_node_id: UUID | None, to_node_id: UUID, hints: list[str]
    ) -> None:
        with self._lock:
            data = self._data(user)
            data.corrections.append(Correction(from_node_id, to_node_id, tuple(hints[:5])))
            del data.corrections[:-500]

    def add_check(
        self,
        user: str,
        clip_id: UUID,
        node_id: UUID | None,
        question: CheckQuestion,
        hints: list[str],
        now: datetime,
    ) -> UUID | None:
        with self._lock:
            data = self._data(user)
            today = _day_start(now)
            made_today = sum(
                1
                for c in data.checks.values()
                if (c.activated_at or c.created_at) >= today and c.status == "active"
            )
            recent = [
                RecentCard(c.id, tuple(c.concept_hints), c.created_at, len(c.merged_clip_ids))
                for c in data.checks.values()
            ]
            plan = plan_new_check(hints, now, recent, made_today)
            if plan.action == "merge" and plan.card_id in data.checks:
                card = data.checks[plan.card_id]
                card.merged_clip_ids = [*card.merged_clip_ids, clip_id]
                return card.id
            check = CheckRow(
                id=uuid.uuid4(),
                clip_id=clip_id,
                node_id=node_id,
                prompt=question.prompt,
                kind=question.kind,
                choices=list(question.choices),
                answer_key=question.answer_key,
                answer_latex=question.answer_latex,
                concept_hints=list(hints[:5]),
                status="active" if plan.action == "active" else "queued",
                due_at=plan.due_at,
                reps=0,
                created_at=now,
                activated_at=now if plan.action == "active" else None,
            )
            data.checks[check.id] = check
            return check.id

    def due_checks(self, user: str, now: datetime) -> list[CheckRow]:
        with self._lock:
            data = self._data(user)
            today = _day_start(now)
            made_today = sum(
                1
                for c in data.checks.values()
                if c.status == "active" and (c.activated_at or c.created_at) >= today
            )
            queued = sorted(
                (c for c in data.checks.values() if c.status == "queued"),
                key=lambda c: c.created_at,
            )
            for check in queued[: room_today(made_today)]:
                check.status, check.due_at, check.activated_at = "active", now, now
            due = [
                replace(c)
                for c in data.checks.values()
                if c.status == "active" and c.due_at is not None
            ]
            return sorted(due, key=lambda c: c.due_at or now)[:MAX_DUE]

    def get_check(self, user: str, check_id: UUID) -> CheckRow | None:
        with self._lock:
            check = self._data(user).checks.get(check_id)
            return replace(check) if check else None

    def schedule(
        self, user: str, check_id: UUID, fsrs_state: dict[str, Any], due_at: datetime, reps: int
    ) -> bool:
        with self._lock:
            check = self._data(user).checks.get(check_id)
            if check is None or check.status != "active":
                return False
            check.fsrs_state, check.due_at, check.reps = fsrs_state, due_at, reps
            return True

    def clear_checks(self, user: str) -> None:
        with self._lock:
            self._data(user).checks.clear()


# ─── Supabase ────────────────────────────────────────────────────────────────────────────────

_CHECK_FIELDS = (
    "id,clip_id,merged_clip_ids,node_id,prompt,kind,choices,answer_key,answer_latex,"
    "concept_hints,status,fsrs_state,due_at,reps,activated_at,created_at"
)


def _check(row: Mapping[str, Any]) -> CheckRow:
    def when(value: Any) -> datetime | None:
        return datetime.fromisoformat(value) if isinstance(value, str) else None

    created = when(row.get("created_at"))
    if created is None:
        raise StoreError("unexpected response from Supabase")
    return CheckRow(
        id=UUID(row["id"]),
        clip_id=UUID(row["clip_id"]),
        node_id=UUID(row["node_id"]) if row.get("node_id") else None,
        prompt=row["prompt"],
        kind=row["kind"],
        choices=[str(c) for c in row.get("choices") or []],
        answer_key=row["answer_key"],
        answer_latex=row.get("answer_latex"),
        concept_hints=list(row.get("concept_hints") or []),
        status=row["status"],
        due_at=when(row.get("due_at")),
        reps=int(row.get("reps") or 0),
        created_at=created,
        fsrs_state=row.get("fsrs_state"),
        merged_clip_ids=[UUID(c) for c in row.get("merged_clip_ids") or []],
        activated_at=when(row.get("activated_at")),
    )


class SupabaseMomentStore(SupabaseRest):
    """Filing and checks through PostgREST: the secret key for the desktop app's calls (always
    filtered to the device's owner), the student's token for theirs."""

    def _mine(self, user: str) -> dict[str, str]:
        return {"user_id": f"eq.{user}"}

    def filing_inputs(
        self, user: str, source_key: str | None
    ) -> tuple[Memory | None, list[Correction]]:
        memory = None
        if source_key:
            rows = self._get(
                "filing_memory",
                {
                    **self._mine(user),
                    "source_key": f"eq.{source_key}",
                    "select": "node_id,corrected",
                },
            )
            if rows:
                memory = Memory(UUID(rows[0]["node_id"]), bool(rows[0]["corrected"]))
        corrections = [
            Correction(
                UUID(r["from_node_id"]) if r.get("from_node_id") else None,
                UUID(r["to_node_id"]),
                tuple(r.get("hints") or ()),
            )
            for r in self._get(
                "filing_corrections",
                {
                    **self._mine(user),
                    "select": "from_node_id,to_node_id,hints",
                    "order": "created_at.desc",
                    "limit": "200",
                },
            )
        ]
        return memory, corrections

    def node_texts(self, user: str) -> dict[UUID, list[str]]:
        texts: dict[UUID, list[str]] = {}
        passages = self._get(
            "chunks",
            {
                **self._mine(user),
                "select": "notebook_node_id,heading,text",
                "notebook_node_id": "not.is.null",
                "limit": str(MAX_PASSAGES),
            },
        )
        for row in passages:
            node = UUID(row["notebook_node_id"])
            text = f"{row.get('heading') or ''} {row.get('text') or ''}"[:PASSAGE_CHARS]
            texts.setdefault(node, []).append(text)
        moments = self._get(
            "clips",
            {
                **self._mine(user),
                "select": "destination,entry",
                "kind": "eq.entry",
                "destination": "not.is.null",
                "order": "created_at.desc",
                "limit": str(MAX_MOMENTS),
            },
        )
        for node, items in moment_texts(moments).items():
            texts.setdefault(node, []).extend(items)
        return texts

    def remember(self, user: str, source_key: str, node_id: UUID, corrected: bool) -> None:
        rows = self._get(
            "filing_memory",
            {**self._mine(user), "source_key": f"eq.{source_key}", "select": "corrected"},
        )
        # A move by the student stays marked as theirs.
        kept = corrected or bool(rows and rows[0]["corrected"])
        if rows:
            self._patch(
                "filing_memory",
                {**self._mine(user), "source_key": f"eq.{source_key}"},
                {
                    "node_id": str(node_id),
                    "corrected": kept,
                    "updated_at": datetime.now(UTC).isoformat(),
                },
            )
            return
        self._insert(
            "filing_memory",
            [
                self._owned(
                    user, {"source_key": source_key, "node_id": str(node_id), "corrected": kept}
                )
            ],
            returning=False,
        )

    def add_correction(
        self, user: str, from_node_id: UUID | None, to_node_id: UUID, hints: list[str]
    ) -> None:
        self._insert(
            "filing_corrections",
            [
                self._owned(
                    user,
                    {
                        "from_node_id": str(from_node_id) if from_node_id else None,
                        "to_node_id": str(to_node_id),
                        "hints": hints[:5],
                    },
                )
            ],
            returning=False,
        )

    def _made_today(self, user: str, now: datetime) -> int:
        rows = self._get(
            "moment_checks",
            {
                **self._mine(user),
                "select": "id",
                "status": "eq.active",
                "activated_at": f"gte.{_day_start(now).isoformat()}",
            },
        )
        return len(rows)

    def add_check(
        self,
        user: str,
        clip_id: UUID,
        node_id: UUID | None,
        question: CheckQuestion,
        hints: list[str],
        now: datetime,
    ) -> UUID | None:
        week = (now - timedelta(days=7)).isoformat()
        recent_rows = self._get(
            "moment_checks",
            {
                **self._mine(user),
                "select": "id,concept_hints,created_at,merged_clip_ids",
                "created_at": f"gte.{week}",
            },
        )
        recent = [
            RecentCard(
                UUID(r["id"]),
                tuple(r.get("concept_hints") or ()),
                datetime.fromisoformat(r["created_at"]),
                len(r.get("merged_clip_ids") or []),
            )
            for r in recent_rows
        ]
        plan = plan_new_check(hints, now, recent, self._made_today(user, now))
        if plan.action == "merge" and plan.card_id is not None:
            merged = next(r for r in recent_rows if r["id"] == str(plan.card_id))
            self._patch(
                "moment_checks",
                {**self._mine(user), "id": f"eq.{plan.card_id}"},
                {"merged_clip_ids": [*(merged.get("merged_clip_ids") or []), str(clip_id)]},
            )
            return plan.card_id
        active = plan.action == "active"
        rows = self._insert(
            "moment_checks",
            [
                self._owned(
                    user,
                    {
                        "clip_id": str(clip_id),
                        "node_id": str(node_id) if node_id else None,
                        "prompt": question.prompt,
                        "kind": question.kind,
                        "choices": list(question.choices),
                        "answer_key": question.answer_key,
                        "answer_latex": question.answer_latex,
                        "concept_hints": hints[:5],
                        "status": "active" if active else "queued",
                        "due_at": plan.due_at.isoformat() if plan.due_at else None,
                        "activated_at": now.isoformat() if active else None,
                    },
                )
            ],
            select="id",
        )
        return UUID(rows[0]["id"]) if rows else None

    def due_checks(self, user: str, now: datetime) -> list[CheckRow]:
        room = room_today(self._made_today(user, now))
        if room > 0:
            queued = self._get(
                "moment_checks",
                {
                    **self._mine(user),
                    "select": "id",
                    "status": "eq.queued",
                    "order": "created_at.asc",
                    "limit": str(room),
                },
            )
            if queued:
                ids = ",".join(r["id"] for r in queued)
                self._patch(
                    "moment_checks",
                    {**self._mine(user), "id": f"in.({ids})"},
                    {
                        "status": "active",
                        "due_at": now.isoformat(),
                        "activated_at": now.isoformat(),
                    },
                )
        rows = self._get(
            "moment_checks",
            {
                **self._mine(user),
                "select": _CHECK_FIELDS,
                "status": "eq.active",
                "order": "due_at.asc",
                "limit": str(MAX_DUE),
            },
        )
        return [_check(r) for r in rows]

    def get_check(self, user: str, check_id: UUID) -> CheckRow | None:
        rows = self._get(
            "moment_checks", {**self._mine(user), "select": _CHECK_FIELDS, "id": f"eq.{check_id}"}
        )
        return _check(rows[0]) if rows else None

    def schedule(
        self, user: str, check_id: UUID, fsrs_state: dict[str, Any], due_at: datetime, reps: int
    ) -> bool:
        rows = self._patch(
            "moment_checks",
            {**self._mine(user), "id": f"eq.{check_id}", "status": "eq.active"},
            {"fsrs_state": fsrs_state, "due_at": due_at.isoformat(), "reps": reps},
        )
        return bool(rows)

    def clear_checks(self, user: str) -> None:
        self._delete("moment_checks", self._mine(user))
