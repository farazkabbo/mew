"""Wire models for moments (K8; camelCase like packages/shared/src/moments.ts)."""

from datetime import datetime
from typing import Annotated, Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, StringConstraints
from pydantic.alias_generators import to_camel

from ..clips.models import AppName, CheckQuestion, PlainText, Subject


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
    #: None for a "quiz me on this" card (S6): nothing was saved.
    clip_id: UUID | None
    origin: Literal["moment", "screen_quiz"] = "moment"
    #: S6: the window it was about, for "From your screen: ...".
    source_title: str | None = None
    #: Other moments about the same concept that week, merged into this card (K8).
    merged_clip_ids: list[UUID] = Field(default_factory=list, max_length=20)
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


class StayedCount(_Camel):
    """How many checks stayed in a notebook (NEB_APP_UI §6.4): all of them, and this week's.
    `notebook_id` is the root notebook (Supabase's view) or the node a check is filed in (local
    mode); the web app adds them up its tree either way."""

    notebook_id: UUID
    stayed_count: int = Field(ge=0)
    stayed_week: int = Field(ge=0)


class StayedCounts(_Camel):
    notebooks: list[StayedCount] = Field(max_length=2000)


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
    #: Answered right, alone, a day or more after it was saved (NEB_APP_UI §6.4): `stayed_at` is
    #: set the first time and kept after that.
    stayed: bool = False


class SuggestionsRequest(_Camel):
    """Unsorted's "File these" (§4.6): the moments waiting there, by id."""

    clip_ids: list[UUID] = Field(min_length=1, max_length=30)


class Suggestion(_Camel):
    """Where one waiting moment would go, or no place (none fits well enough to suggest)."""

    clip_id: UUID
    node_id: UUID | None = None
    path: list[Title] | None = Field(default=None, min_length=1, max_length=3)
    method: Literal["source_memory", "content_match", "subject_match", "sticky"] | None = None
    matched: str | None = None


class Suggestions(_Camel):
    suggestions: list[Suggestion]


class MomentMove(_Camel):
    """The student filed a moment from the notebook (moved it, or accepted a suggestion)."""

    node_id: UUID


class QuizQuestionIn(_Camel):
    """One verified "quiz me on this" question and what it's about (S6)."""

    question: CheckQuestion
    hints: list[Hint] = Field(default_factory=list, max_length=5)


class QuizCardsRequest(_Camel):
    """The desktop app's "quiz me on this" (through the web server): its questions, to keep as
    recall cards. The window title is shown with them in the review."""

    questions: list[QuizQuestionIn] = Field(min_length=1, max_length=3)
    source_title: Title | None = None
    source_app: AppName | None = None


class QuizCardsResponse(_Camel):
    check_ids: list[UUID]
