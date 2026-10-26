"""Wire models for moments (K8; camelCase like packages/shared/src/moments.ts)."""

from datetime import datetime
from typing import Annotated, Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, StringConstraints
from pydantic.alias_generators import to_camel

from ..clips.models import PlainText, Subject


class _Camel(BaseModel):
    model_config = ConfigDict(extra="forbid", alias_generator=to_camel, populate_by_name=True)


Hint = Annotated[PlainText, StringConstraints(strip_whitespace=True, min_length=1, max_length=80)]
Title = Annotated[str, StringConstraints(min_length=1, max_length=200)]


class FilingRequest(_Camel):
    """A moment to file (the desktop app's Circle & Ask, through the web server): what the answer
    said it's about. Never page content, never titles."""

    source_key: Annotated[str, StringConstraints(min_length=1, max_length=300)] | None = None
    subject: Subject | None = None
    hints: list[Hint] = Field(default_factory=list, max_length=5)
    #: The source's place from the last two hours, kept by the web server (K3).
    sticky_node_id: UUID | None = None


class FiledPlace(_Camel):
    node_id: UUID
    path: list[Title] = Field(min_length=1, max_length=3)


class FilingResponse(_Camel):
    method: Literal["source_memory", "content_match", "subject_match", "sticky", "unsorted"]
    node_id: UUID
    path: list[Title] = Field(min_length=1, max_length=3)
    score: float = Field(ge=0, le=1)
    matched: str | None = None
    alternatives: list[FiledPlace] = Field(max_length=3)
    new_notebook: str | None = None


class CheckView(_Camel):
    """A due check without its key (the review and Quick check ask it)."""

    id: UUID
    clip_id: UUID
    node_id: UUID | None
    prompt: str
    kind: Literal["short", "mcq", "work"]
    choices: list[str]
    concept_hints: list[str]
    is_new: bool
    due_at: datetime
    created_at: datetime


class ChecksDue(_Camel):
    checks: list[CheckView]


class CheckWithKey(CheckView):
    """For the web server only, to grade an answer: never sent to the browser before it's
    answered."""

    answer_key: str
    answer_latex: str | None
    fsrs_state: dict[str, Any] | None
    reps: int


class CheckSchedule(_Camel):
    """A check's new schedule after an answer (FSRS runs on the web server)."""

    fsrs_state: dict[str, Any]
    due_at: datetime
    reps: int = Field(ge=0, le=100_000)
