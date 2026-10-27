"""Where skills live (Screen Coach S5; migration 20261108000000_skills.sql).

- Supabase: the secret key for the desktop app's walkthroughs (after its device token was
  checked; every query is filtered to the owner), the student's own token for their review.
- Memory, for local mode.

A skill links to a course concept when one of the student's own concepts names the same task
("Pivot tables" and "Pivot tables"; "Making charts" and "Charts"): titles only, never content.
"""

import re
import threading
import uuid
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Protocol
from uuid import UUID

from ..courses.models import Concept
from ..supabase_rest import SupabaseRest
from .models import SkillOut, SkillRecord, SkillView

MAX_SKILLS = 500


def skill_key(title: str, app: str | None) -> str:
    """Mirrors `skillKey` in packages/shared/src/skills.ts."""
    return f"{' '.join(title.split()).lower()}|{app or ''}"[:130]


def _words(text: str) -> set[str]:
    return {
        re.sub(r"(ies|es|s)$", "", w) for w in re.findall(r"[a-z0-9]+", text.lower()) if len(w) > 2
    }


def concept_for(title: str, concepts: Iterable[Concept]) -> Concept | None:
    """The student's course concept that is this task, if one names it (all its words, or all
    the skill's): titles only."""
    wanted = _words(title)
    if not wanted:
        return None
    for concept in concepts:
        have = _words(concept.title)
        if have and (have <= wanted or wanted <= have):
            return concept
    return None


class SkillStore(Protocol):
    def device_list(self, user: str) -> list[SkillOut]: ...
    def record(self, user: str, record: SkillRecord) -> SkillOut: ...
    def views(self, user: str) -> list[SkillView]: ...
    def delete(self, user: str, skill_id: UUID) -> bool: ...


# ─── Memory (local mode) ─────────────────────────────────────────────────────────────────────


@dataclass
class _Skill:
    id: UUID
    title: str
    app: str | None
    key: str
    fsrs_state: dict[str, Any]
    due_at: datetime
    last_walkthrough_id: UUID | None
    concept: Concept | None
    evidence: list[tuple[str, str, int, datetime]] = field(default_factory=list)


class MemorySkillStore:
    def __init__(self, concepts: Callable[[str], Sequence[Concept]]) -> None:
        self._concepts = concepts
        self._skills: dict[str, dict[str, _Skill]] = {}
        self._lock = threading.Lock()

    def device_list(self, user: str) -> list[SkillOut]:
        with self._lock:
            return [_out(s) for s in self._skills.get(user, {}).values()]

    def record(self, user: str, record: SkillRecord) -> SkillOut:
        concepts = self._concepts(user)
        key = skill_key(record.title, record.app)
        with self._lock:
            mine = self._skills.setdefault(user, {})
            skill = mine.get(key)
            if skill is None:
                if len(mine) >= MAX_SKILLS:
                    raise ValueError("too many skills")
                skill = _Skill(
                    uuid.uuid4(),
                    record.title,
                    record.app,
                    key,
                    record.card,
                    record.due_at,
                    record.walkthrough_id,
                    concept_for(record.title, concepts),
                )
                mine[key] = skill
            skill.fsrs_state, skill.due_at = record.card, record.due_at
            skill.last_walkthrough_id = record.walkthrough_id
            skill.evidence.append((record.kind, record.evidence, record.hints, datetime.now(UTC)))
            return _out(skill)

    def views(self, user: str) -> list[SkillView]:
        with self._lock:
            skills = list(self._skills.get(user, {}).values())
        return sorted(
            (
                _view(
                    s.id,
                    s.title,
                    s.app,
                    s.concept.title if s.concept else None,
                    s.due_at,
                    s.evidence,
                )
                for s in skills
            ),
            key=lambda v: v.due_at,
        )

    def delete(self, user: str, skill_id: UUID) -> bool:
        with self._lock:
            mine = self._skills.get(user, {})
            key = next((k for k, s in mine.items() if s.id == skill_id), None)
            return key is not None and mine.pop(key, None) is not None


def _out(skill: _Skill) -> SkillOut:
    return SkillOut(
        id=skill.id,
        title=skill.title,
        app=skill.app,
        due_at=skill.due_at,
        fsrs_state=skill.fsrs_state,
        last_walkthrough_id=skill.last_walkthrough_id,
    )


def _view(
    skill_id: UUID,
    title: str,
    app: str | None,
    concept_title: str | None,
    due_at: datetime,
    evidence: Sequence[tuple[str, str, int, datetime]],
) -> SkillView:
    """`evidence`: (kind, evidence, hints, at), oldest first."""
    last = evidence[-1] if evidence else None
    return SkillView(
        id=skill_id,
        title=title,
        app=app,
        concept_title=concept_title,
        due_at=due_at,
        last_evidence=last[1] if last else None,
        last_hints=last[2] if last else 0,
        last_at=last[3] if last else None,
        solo=sum(1 for kind, ev, _, _ in evidence if kind == "recheck" and ev == "independent"),
    )


# ─── Supabase ────────────────────────────────────────────────────────────────────────────────

_FIELDS = "id,title,app_exe_name,due_at,fsrs_state,last_walkthrough_id"


def _skill_out(row: dict[str, Any]) -> SkillOut:
    return SkillOut(
        id=UUID(row["id"]),
        title=row["title"],
        app=row.get("app_exe_name"),
        due_at=datetime.fromisoformat(row["due_at"]),
        fsrs_state=row["fsrs_state"],
        last_walkthrough_id=UUID(row["last_walkthrough_id"])
        if row.get("last_walkthrough_id")
        else None,
    )


class SupabaseSkillStore(SupabaseRest):
    """Skills through PostgREST: written with the secret key (filtered to the owner), read by
    the student with their own token."""

    def __init__(
        self, *args: Any, concepts: Callable[[str], Sequence[Concept]], **kwargs: Any
    ) -> None:
        super().__init__(*args, **kwargs)
        self._concepts = concepts

    def _mine(self, user: str) -> dict[str, str]:
        return {"user_id": f"eq.{user}"}

    def device_list(self, user: str) -> list[SkillOut]:
        rows = self._get(
            "skills", {**self._mine(user), "select": _FIELDS, "limit": str(MAX_SKILLS)}
        )
        return [_skill_out(r) for r in rows]

    def record(self, user: str, record: SkillRecord) -> SkillOut:
        if not self.service:
            raise PermissionError("skills are recorded by the service")
        key = skill_key(record.title, record.app)
        existing = self._get("skills", {**self._mine(user), "key": f"eq.{key}", "select": "id"})
        fields = {
            "fsrs_state": record.card,
            "due_at": record.due_at.isoformat(),
            "last_walkthrough_id": str(record.walkthrough_id),
            "updated_at": datetime.now(UTC).isoformat(),
        }
        if existing:
            [row] = self._patch(
                "skills", {**self._mine(user), "id": f"eq.{existing[0]['id']}"}, fields
            )
        else:
            concept = concept_for(record.title, self._concepts(user))
            [row] = self._insert(
                "skills",
                [
                    self._owned(
                        user,
                        {
                            "title": record.title,
                            "app_exe_name": record.app,
                            "key": key,
                            **(
                                {"course_id": str(concept.course_id), "concept_id": str(concept.id)}
                                if concept
                                else {}
                            ),
                            **fields,
                        },
                    )
                ],
            )
        skill = _skill_out(row)
        self._insert(
            "skill_evidence",
            [
                self._owned(
                    user,
                    {
                        "skill_id": str(skill.id),
                        "walkthrough_id": str(record.walkthrough_id),
                        "kind": record.kind,
                        "evidence": record.evidence,
                        "hints": record.hints,
                    },
                )
            ],
            returning=False,
        )
        return skill

    def views(self, user: str) -> list[SkillView]:
        rows = self._get(
            "skills",
            {
                **self._mine(user),
                "select": "id,title,app_exe_name,due_at,concepts(title),"
                "skill_evidence(kind,evidence,hints,created_at)",
                "order": "due_at.asc",
                "limit": str(MAX_SKILLS),
            },
        )
        views = []
        for row in rows:
            evidence = sorted(
                (
                    (
                        e["kind"],
                        e["evidence"],
                        int(e["hints"]),
                        datetime.fromisoformat(e["created_at"]),
                    )
                    for e in row.get("skill_evidence") or []
                ),
                key=lambda e: e[3],
            )
            concept = row.get("concepts") or None
            views.append(
                _view(
                    UUID(row["id"]),
                    row["title"],
                    row.get("app_exe_name"),
                    concept.get("title") if isinstance(concept, dict) else None,
                    datetime.fromisoformat(row["due_at"]),
                    evidence,
                )
            )
        return views

    def delete(self, user: str, skill_id: UUID) -> bool:
        rows = self._request(
            "DELETE",
            "/rest/v1/skills",
            params={**self._mine(user), "id": f"eq.{skill_id}"},
            headers={"Prefer": "return=representation"},
        ).json()
        return bool(rows)
