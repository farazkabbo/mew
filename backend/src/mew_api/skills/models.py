"""Wire models for skills (Screen Coach S5; camelCase like packages/shared/src/skills.ts)."""

from datetime import datetime
from typing import Annotated, Any, Literal, Self
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator
from pydantic.alias_generators import to_camel

from ..clips.models import AppName, PlainText

Evidence = Literal["independent", "with_hint", "after_explanation", "not_yet"]
Kind = Literal["guided", "recheck"]


class _Camel(BaseModel):
    model_config = ConfigDict(extra="forbid", alias_generator=to_camel, populate_by_name=True)


class SkillRecord(_Camel):
    """A finished walkthrough's outcome, from the web server (it ran the walkthrough and worked
    out the evidence and the new FSRS card; the desktop app never sends this)."""

    walkthrough_id: UUID
    title: Annotated[
        PlainText, StringConstraints(strip_whitespace=True, min_length=1, max_length=60)
    ]
    app: AppName | None
    kind: Kind
    evidence: Evidence
    hints: int = Field(ge=0, le=45)
    card: dict[str, Any]
    due_at: datetime

    @model_validator(mode="after")
    def _coaching_is_never_independent(self) -> Self:
        if self.kind == "guided" and self.evidence == "independent":
            raise ValueError("a guided walkthrough is never independent")
        return self


class SkillOut(_Camel):
    """A skill as the web server needs it to run a re-check or record one."""

    id: UUID
    title: str
    app: str | None
    due_at: datetime
    fsrs_state: dict[str, Any]
    last_walkthrough_id: UUID | None


class SkillsOut(_Camel):
    skills: list[SkillOut]


class SkillView(_Camel):
    """A skill as the student's review shows it."""

    id: UUID
    title: str
    app: str | None
    concept_title: str | None
    due_at: datetime
    last_evidence: Evidence | None
    last_hints: int
    last_at: datetime | None
    solo: int


class SkillsView(_Camel):
    skills: list[SkillView]
