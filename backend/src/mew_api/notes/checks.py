"""Where Notes Check results are kept (§4.2): Supabase (notes_checks, notes_findings,
note_source_links) or, in local mode, memory.

A finding's page is worked out here from the student's own lines, never taken from the request,
and line ids that aren't the student's are dropped: a finding can only point at their notes.
"""

import threading
import uuid
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Protocol
from uuid import UUID

from ..supabase_rest import StoreError, SupabaseRest
from .models import CheckCreate, CheckCreated, FindingCreate, FindingUpdate, FindingView

#: Open findings marked on a page at most (the newest first).
PAGE_FINDINGS = 50


class CheckStore(Protocol):
    def save(self, user: str, check: CheckCreate) -> CheckCreated: ...

    def get_finding(self, user: str, finding_id: UUID) -> FindingView | None: ...

    def open_findings(self, user: str, page_id: UUID) -> list[FindingView]:
        """The page's findings still open, newest first (its marks after a reload)."""
        ...

    def update_finding(
        self, user: str, finding_id: UUID, update: FindingUpdate
    ) -> FindingView | None:
        """Resolves an open finding; None if there's no such open finding (outcomes are final,
        so a second tab can't record one twice)."""
        ...


def _view(row: dict[str, Any], course_id: object) -> FindingView:
    return FindingView.model_validate(
        {
            "id": row["id"],
            "check_id": row["check_id"],
            "type": row["type"],
            "note_line_ids": row.get("note_line_ids") or [],
            "page_id": row.get("page_id"),
            "note_quote": row.get("note_quote"),
            "screen_snippet": row["screen_snippet"],
            "question": row.get("question"),
            "explanation": row.get("explanation") or "",
            "concept_hint": row.get("concept_hint"),
            "concept_id": row.get("concept_id"),
            "confidence": row["confidence"],
            "source_conflict": row.get("source_conflict", False),
            "status": row["status"],
            "course_id": course_id,
        }
    )


def _course_of(scope: object) -> object:
    return scope.get("course_id") if isinstance(scope, dict) else None


def _finding_row(
    check_id: UUID, finding: FindingCreate, pages: dict[UUID, UUID]
) -> dict[str, Any] | None:
    """The finding as a row, with only the student's lines; None if it names none of them (a
    gap names none and is kept)."""
    lines = [line for line in finding.note_line_ids if line in pages]
    if finding.note_line_ids and not lines:
        return None
    anchor = finding.anchor_line_id or (lines[0] if lines else None)
    return {
        "check_id": str(check_id),
        "page_id": str(pages[anchor]) if anchor in pages else None,
        "type": finding.type,
        "note_line_ids": [str(line) for line in lines],
        "note_quote": finding.note_quote,
        "screen_snippet": finding.screen_snippet,
        "question": finding.question,
        "explanation": finding.explanation,
        "concept_hint": finding.concept_hint,
        "confidence": finding.confidence,
        "source_conflict": finding.source_conflict,
    }


def _check_row(check: CheckCreate) -> dict[str, Any]:
    return {
        "scope": check.scope.model_dump(mode="json"),
        "source_app": check.source_app,
        "model_version": check.model_version,
        "latency_ms": check.latency_ms,
    }


def _line_ids(check: CheckCreate) -> set[UUID]:
    ids = {line for f in check.findings for line in f.note_line_ids}
    ids |= {f.anchor_line_id for f in check.findings if f.anchor_line_id}
    return ids | {link.note_line_id for link in check.links}


# ─── Local mode ──────────────────────────────────────────────────────────────────────────────


@dataclass
class _Stored:
    check: dict[str, Any]
    findings: dict[UUID, dict[str, Any]] = field(default_factory=dict)
    links: list[dict[str, Any]] = field(default_factory=list)


class MemoryCheckStore:
    """Checks per user in memory (development only). `pages_of` says which of the user's lines
    exist and on which page (the local note store answers it)."""

    def __init__(self, pages_of: "PagesOf") -> None:
        self._pages_of = pages_of
        self._checks: dict[str, dict[UUID, _Stored]] = {}
        self._lock = threading.Lock()
        self._order = iter(range(1, 1 << 62))

    def save(self, user: str, check: CheckCreate) -> CheckCreated:
        pages = self._pages_of(user, sorted(_line_ids(check), key=str))
        check_id = uuid.uuid4()
        stored = _Stored(_check_row(check))
        ids: list[UUID | None] = []
        for finding in check.findings:
            row = _finding_row(check_id, finding, pages)
            finding_id = uuid.uuid4() if row else None
            if row and finding_id:
                stored.findings[finding_id] = {
                    **row,
                    "id": str(finding_id),
                    "status": "open",
                    "created": next(self._order),
                }
            ids.append(finding_id)
        for link in check.links:
            finding_id = ids[link.finding]
            if link.note_line_id in pages:
                stored.links.append({**link.model_dump(mode="json"), "finding_id": finding_id})
        with self._lock:
            self._checks.setdefault(user, {})[check_id] = stored
        return CheckCreated(check_id=check_id, finding_ids=ids)

    def findings_of(self, user: str) -> list[dict[str, Any]]:
        """Every stored finding of the user's (for tests)."""
        with self._lock:
            return [f for c in self._checks.get(user, {}).values() for f in c.findings.values()]

    def _rows(self, user: str) -> Iterable[tuple[dict[str, Any], dict[str, Any]]]:
        for stored in self._checks.get(user, {}).values():
            for row in stored.findings.values():
                yield row, stored.check

    def get_finding(self, user: str, finding_id: UUID) -> FindingView | None:
        with self._lock:
            for row, check in self._rows(user):
                if row["id"] == str(finding_id):
                    return _view(row, _course_of(check["scope"]))
        return None

    def open_findings(self, user: str, page_id: UUID) -> list[FindingView]:
        with self._lock:
            rows = [
                (row, check)
                for row, check in self._rows(user)
                if row["page_id"] == str(page_id) and row["status"] == "open"
            ]
        rows.sort(key=lambda pair: -int(pair[0]["created"]))
        return [_view(row, _course_of(check["scope"])) for row, check in rows[:PAGE_FINDINGS]]

    def update_finding(
        self, user: str, finding_id: UUID, update: FindingUpdate
    ) -> FindingView | None:
        with self._lock:
            for row, check in self._rows(user):
                if row["id"] == str(finding_id) and row["status"] == "open":
                    row["status"] = update.status
                    if update.concept_id:
                        row["concept_id"] = str(update.concept_id)
                    return _view(row, _course_of(check["scope"]))
        return None


class PagesOf(Protocol):
    def __call__(self, user: str, line_ids: Sequence[UUID]) -> dict[UUID, UUID]: ...


# ─── Supabase ────────────────────────────────────────────────────────────────────────────────


class SupabaseCheckStore(SupabaseRest):
    """With the student's token (RLS) or, for the desktop app, the secret key after its device
    token was verified (user_id set on every row by `_owned`)."""

    def save(self, user: str, check: CheckCreate) -> CheckCreated:
        pages = self._pages(user, _line_ids(check))
        [created] = self._insert(
            "notes_checks", [self._owned(user, _check_row(check))], select="id"
        )
        check_id = UUID(created["id"])
        try:
            rows = [_finding_row(check_id, f, pages) for f in check.findings]
            stored = self._insert(
                "notes_findings", [self._owned(user, r) for r in rows if r], select="id"
            )
            stored_ids = iter(UUID(r["id"]) for r in stored)
            ids: list[UUID | None] = [next(stored_ids) if r else None for r in rows]
            links = [
                self._owned(
                    user,
                    {
                        "note_line_id": str(link.note_line_id),
                        "clip_id": str(link.clip_id) if link.clip_id else None,
                        "url": link.url,
                        "title": link.title,
                        "timestamp_sec": link.timestamp_sec,
                        "created_from_finding_id": str(fid) if (fid := ids[link.finding]) else None,
                    },
                )
                for link in check.links
                if link.note_line_id in pages
            ]
            self._insert("note_source_links", links, returning=False)
        except (PermissionError, StoreError):
            # One check is all or nothing: its findings go with it.
            self._delete("notes_checks", {"user_id": f"eq.{user}", "id": f"eq.{check_id}"})
            raise
        return CheckCreated(check_id=check_id, finding_ids=ids)

    def get_finding(self, user: str, finding_id: UUID) -> FindingView | None:
        rows = self._get("notes_findings", {"user_id": f"eq.{user}", "id": f"eq.{finding_id}"})
        views = self._with_courses(user, rows)
        return views[0] if views else None

    def open_findings(self, user: str, page_id: UUID) -> list[FindingView]:
        rows = self._get(
            "notes_findings",
            {
                "user_id": f"eq.{user}",
                "page_id": f"eq.{page_id}",
                "status": "eq.open",
                "order": "created_at.desc",
                "limit": str(PAGE_FINDINGS),
            },
        )
        return self._with_courses(user, rows)

    def update_finding(
        self, user: str, finding_id: UUID, update: FindingUpdate
    ) -> FindingView | None:
        fields: dict[str, Any] = {
            "status": update.status,
            "resolved_at": datetime.now(UTC).isoformat(),
        }
        if update.concept_id:
            fields["concept_id"] = str(update.concept_id)
        rows = self._patch(
            "notes_findings",
            {"user_id": f"eq.{user}", "id": f"eq.{finding_id}", "status": "eq.open"},
            fields,
        )
        views = self._with_courses(user, rows)
        return views[0] if views else None

    def _with_courses(self, user: str, rows: list[dict[str, Any]]) -> list[FindingView]:
        """The findings, each with the course of its check's scope."""
        checks = {str(r["check_id"]) for r in rows}
        scopes: dict[str, object] = {}
        if checks:
            for check in self._get(
                "notes_checks",
                {
                    "select": "id,scope",
                    "user_id": f"eq.{user}",
                    "id": f"in.({','.join(sorted(checks))})",
                },
            ):
                scopes[str(check["id"])] = check.get("scope")
        return [_view(r, _course_of(scopes.get(str(r["check_id"])))) for r in rows]

    def _pages(self, user: str, line_ids: set[UUID]) -> dict[UUID, UUID]:
        if not line_ids:
            return {}
        rows = self._get(
            "note_lines",
            {
                "select": "id,page_id",
                "user_id": f"eq.{user}",
                "id": f"in.({','.join(str(i) for i in sorted(line_ids, key=str))})",
            },
        )
        return {UUID(r["id"]): UUID(r["page_id"]) for r in rows}
