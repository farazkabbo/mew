"""Learner data and API payloads (mirrored by zod schemas in packages/shared/src/learner.ts).

Scheduling (FSRS) runs on the web server, which sends the updated card with each attempt; this
service validates and stores it.
"""

from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field

Evidence = Literal["independent", "with_hint", "after_explanation"]
AttemptSource = Literal["practice", "quiz", "notes_check"]


class _Model(BaseModel):
    model_config = ConfigDict(extra="forbid")


class FsrsCard(_Model):
    """A ts-fsrs card, as stored in review_cards.fsrs_state."""

    due: AwareDatetime
    stability: float = Field(ge=0, le=36_500)
    difficulty: float = Field(ge=0, le=10)
    elapsed_days: float = Field(ge=0, le=36_500)
    scheduled_days: float = Field(ge=0, le=36_500)
    learning_steps: int = Field(ge=0, le=100)
    reps: int = Field(ge=0, le=100_000)
    lapses: int = Field(ge=0, le=100_000)
    state: int = Field(ge=0, le=3)
    last_review: AwareDatetime | None


class AttemptWrite(_Model):
    """One answer, and the concept's card rescheduled for it."""

    concept_id: UUID
    correct: bool
    evidence: Evidence
    source: AttemptSource
    card: FsrsCard


class ExploredWrite(_Model):
    """The student opened a concept: start its card (kept as is if it already exists)."""

    concept_id: UUID
    card: FsrsCard


class AttemptRecord(_Model):
    concept_id: UUID
    correct: bool
    evidence: Evidence
    source: AttemptSource
    created_at: datetime


class CardRecord(_Model):
    concept_id: UUID
    fsrs_state: FsrsCard
    due_at: datetime


class LearnerData(_Model):
    #: Oldest first (the most recent MAX_ATTEMPTS of the course).
    attempts: list[AttemptRecord]
    cards: list[CardRecord]


class DueCard(_Model):
    course_id: UUID
    course_title: str
    concept_id: UUID
    concept_title: str
    due_at: datetime
    reps: int


class DueCards(_Model):
    cards: list[DueCard]


#: Attempts loaded per course (Supabase's API returns at most 1000 rows per request).
MAX_ATTEMPTS = 1000
#: Due cards listed at once (the review screen).
MAX_DUE = 200
