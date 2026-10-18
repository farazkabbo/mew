"""Course data and API payloads (mirrored by zod schemas in packages/shared/src/course.ts)."""

from datetime import date, datetime
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, BeforeValidator, ConfigDict, Field, StringConstraints

CourseStatus = Literal["processing", "review", "ready", "failed"]
Subject = Literal[
    "math", "physics", "chemistry", "biology", "history", "language", "programming", "other"
]

Title = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=120)]


def clipped(limit: int) -> BeforeValidator:
    """Model output: trim over-long text to the limit rather than reject a useful answer."""
    return BeforeValidator(lambda v: v[:limit] if isinstance(v, str) else v)


def first(limit: int) -> BeforeValidator:
    """Model output: keep the first items of an over-long list rather than reject it."""
    return BeforeValidator(lambda v: v[:limit] if isinstance(v, list) else v)


class _Model(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Course(_Model):
    id: UUID
    title: str
    subject: str | None = None
    exam_date: date | None = None
    status: CourseStatus
    status_detail: str | None = None
    created_at: datetime


class Source(_Model):
    id: UUID
    course_id: UUID
    kind: Literal["pdf", "text", "topic"]
    title: str
    page_count: int | None = None
    embedding_model: str
    storage_path: str | None = None


class PracticeQuestion(_Model):
    question: Annotated[str, clipped(400), StringConstraints(min_length=1, max_length=400)]
    answer: Annotated[str, clipped(600), StringConstraints(max_length=600)]
    hint: Annotated[str, clipped(300), StringConstraints(max_length=300)] = ""


class Lesson(_Model):
    explanation: Annotated[str, clipped(2400), StringConstraints(min_length=1, max_length=2400)]
    worked_example: Annotated[str, clipped(2400), StringConstraints(max_length=2400)] = ""
    practice: Annotated[list[PracticeQuestion], first(5), Field(max_length=5)] = Field(
        default_factory=list
    )
    #: Pages of the source the lesson draws on.
    pages: Annotated[list[int], first(20), Field(max_length=20)] = Field(default_factory=list)
    generated: bool = True


class Concept(_Model):
    id: UUID
    course_id: UUID
    title: str
    summary: str
    order_index: int
    source_pages: list[int]
    lesson: Lesson | None = None


class Edge(_Model):
    from_concept: UUID
    to_concept: UUID


class CourseDetail(_Model):
    course: Course
    sources: list[Source]
    concepts: list[Concept]
    edges: list[Edge]


class RetrievedChunk(_Model):
    page: int
    heading: str | None
    text: str
    similarity: float
    source_title: str


class NewChunk(_Model):
    page: int
    heading: str | None
    text: str
    embedding: list[float]


class NewConcept(_Model):
    title: str
    summary: str
    order_index: int
    source_pages: list[int]


# ─── Requests ───────────────────────────────────────────────────────────────────────────────


class CourseUpdate(_Model):
    title: Title | None = None
    exam_date: date | None = None
    #: The scope review is done: the course is ready to study.
    status: Literal["ready"] | None = None


class Merge(_Model):
    into: UUID
    sources: list[UUID] = Field(min_length=1, max_length=20)


class ConceptReview(_Model):
    """The student's edits on the scope review screen: merges first, then the final order
    (concepts left out are removed), then renames."""

    merges: list[Merge] = Field(default_factory=list, max_length=20)
    order: list[UUID] = Field(min_length=1, max_length=60)
    titles: dict[UUID, Title] = Field(default_factory=dict, max_length=60)


class RetrieveRequest(_Model):
    query: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=600)]
    k: int = Field(default=4, ge=1, le=8)


class RetrieveResponse(_Model):
    chunks: list[RetrievedChunk]
