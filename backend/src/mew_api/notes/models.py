"""Wire models for note lines (camelCase, like packages/shared/src/notes.ts): the recognised text
of a student's notebook lines, synced a page at a time (Notes Check N1,
docs/SCREEN_COACH_NOTES_CHECK.md §4.1).

The browser owns the strokes and decides what a line is; everything it sends is checked again
here (sizes, ids, a clip line naming its clip) before it reaches the database.
"""

import re
from typing import Annotated, Literal, Self
from uuid import UUID

from pydantic import (
    AfterValidator,
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    model_validator,
)
from pydantic.alias_generators import to_camel

from ..clips.models import AppName, ClipUrl

TEXT_CHARS = 300
LINES_PER_SYNC = 200
REMOVED_PER_SYNC = 1000

_CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


def _plain(text: str) -> str:
    if _CONTROL.search(text):
        raise ValueError("control characters aren't allowed")
    return text


PlainText = Annotated[str, AfterValidator(_plain)]

# Trimmed, then 1 to n characters, without control characters. The length constraints come
# before the plain-text check on purpose: wrapping `PlainText` in them checks the length before
# trimming, so "   " would pass as an empty string.
LineText = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=TEXT_CHARS),
    AfterValidator(_plain),
]
NotebookTitle = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=200),
    AfterValidator(_plain),
]


class _Camel(BaseModel):
    model_config = ConfigDict(extra="forbid", alias_generator=to_camel, populate_by_name=True)


class NotebookRef(_Camel):
    """The notebook a page belongs to, mirrored so lines can be scoped to it (and its course)."""

    id: UUID
    title: NotebookTitle
    course_id: UUID | None


class NoteLineUpsert(_Camel):
    id: UUID
    #: Reading order on the page, top to bottom.
    line_index: int = Field(ge=0, le=10_000)
    #: [x, y, w, h] in page units.
    bbox: tuple[float, float, float, float]
    source: Literal["ink", "clip"]
    clip_id: UUID | None = None
    text: LineText
    latex: Annotated[PlainText, StringConstraints(max_length=TEXT_CHARS)] | None
    confidence: float = Field(ge=0, le=1)
    content_hash: Annotated[str, StringConstraints(pattern=r"^[0-9a-f]{8}$")]

    @model_validator(mode="after")
    def _clip_lines_name_their_clip(self) -> Self:
        if (self.source == "clip") != (self.clip_id is not None):
            raise ValueError("a clip line names its clip, and only a clip line does")
        if self.bbox[2] < 0 or self.bbox[3] < 0:
            raise ValueError("a box has no negative size")
        return self


class NotePageSync(_Camel):
    """What changed on one page since its last sync."""

    notebook: NotebookRef
    page_index: int = Field(ge=0, le=10_000)
    upsert: list[NoteLineUpsert] = Field(max_length=LINES_PER_SYNC)
    #: Lines that are gone, or changed and not recognised again yet.
    remove: list[UUID] = Field(max_length=REMOVED_PER_SYNC)

    @model_validator(mode="after")
    def _each_line_once(self) -> Self:
        ids = [line.id for line in self.upsert]
        if len(set(ids)) != len(ids) or set(ids) & set(self.remove):
            raise ValueError("each line appears once")
        return self


class NotePageSyncResult(_Camel):
    #: Lines whose text was embedded again (the rest kept their embedding).
    embedded: int


# ─── Retrieval (N2) ──────────────────────────────────────────────────────────────────────────

SCREEN_BLOCKS = 80
SCREEN_BLOCK_CHARS = 1000
SCREEN_CHARS = 8000

BlockId = Annotated[str, StringConstraints(pattern=r"^[A-Za-z0-9_-]{1,16}$")]


class ScreenBlock(_Camel):
    """A block of text on the student's screen, as on-device OCR read it (after redaction).
    Learning material to compare with, never instructions."""

    block_id: BlockId
    text: Annotated[
        PlainText,
        StringConstraints(strip_whitespace=True, min_length=1, max_length=SCREEN_BLOCK_CHARS),
    ]


class RetrieveScope(_Camel):
    """Which notes to look in. "default": the course of the notebook the student is working in
    (the one whose lines changed last), or that notebook alone when it has no course."""

    kind: Literal["default", "notebook", "course", "all"]
    notebook_id: UUID | None = None
    course_id: UUID | None = None

    @model_validator(mode="after")
    def _ids_match_the_kind(self) -> Self:
        if (self.kind == "notebook") != (self.notebook_id is not None):
            raise ValueError("a notebook scope names its notebook, and only it does")
        if (self.kind == "course") != (self.course_id is not None):
            raise ValueError("a course scope names its course, and only it does")
        return self


class RetrieveRequest(_Camel):
    screen: list[ScreenBlock] = Field(min_length=1, max_length=SCREEN_BLOCKS)
    scope: RetrieveScope
    #: A saved clip being checked against the notes: its own text lines are left out.
    exclude_clip_id: UUID | None = None

    @model_validator(mode="after")
    def _screen_is_capped(self) -> Self:
        if sum(len(b.text) for b in self.screen) > SCREEN_CHARS:
            raise ValueError("too much screen text")
        if len({b.block_id for b in self.screen}) != len(self.screen):
            raise ValueError("each block appears once")
        return self


class RetrievedLine(_Camel):
    line_id: UUID
    page_id: UUID
    line_index: int
    bbox: tuple[float, float, float, float]
    source: Literal["ink", "clip"]
    clip_id: UUID | None
    text: str
    latex: str | None
    confidence: float
    #: Found by the search itself (the others are its neighbours, for context).
    hit: bool


class RetrievedPage(_Camel):
    page_id: UUID
    notebook_id: UUID
    notebook_title: str
    #: 0-based; shown to the student as page_index + 1.
    page_index: int


class CoursePassage(_Camel):
    page: int
    heading: str | None
    text: str


class UsedScope(_Camel):
    kind: Literal["notebook", "course", "all"]
    course_id: UUID | None = None
    #: The notebooks searched (empty for "all").
    notebook_ids: list[UUID] = Field(default_factory=list)


class RetrieveResponse(_Camel):
    scope: UsedScope
    #: False when nothing in the notes relates to the screen: the comparison is skipped.
    related: bool
    pages: list[RetrievedPage]
    lines: list[RetrievedLine]
    passages: list[CoursePassage]


# ─── Checks (N3) ─────────────────────────────────────────────────────────────────────────────

FindingType = Literal["match", "difference", "gap", "unclear"]


class FindingCreate(_Camel):
    type: FindingType
    note_line_ids: list[UUID] = Field(max_length=12)
    #: The line whose page the finding belongs to (its first line, or where a gap would go).
    anchor_line_id: UUID | None = None
    note_quote: Annotated[PlainText, StringConstraints(max_length=200)] | None = None
    screen_snippet: Annotated[PlainText, StringConstraints(min_length=1, max_length=200)]
    question: Annotated[PlainText, StringConstraints(max_length=240)] | None = None
    explanation: Annotated[PlainText, StringConstraints(max_length=300)]
    concept_hint: Annotated[PlainText, StringConstraints(max_length=80)] | None = None
    confidence: float = Field(ge=0, le=1)
    source_conflict: bool


class SourceLinkCreate(_Camel):
    """A matched line's source, for its link chip: a saved clip, or the page or video watched."""

    note_line_id: UUID
    #: Which finding (by position in `findings`) made the link.
    finding: int = Field(ge=0, lt=24)
    clip_id: UUID | None = None
    url: ClipUrl | None = None
    title: Annotated[PlainText, StringConstraints(min_length=1, max_length=200)] | None = None
    timestamp_sec: int | None = Field(default=None, ge=0, le=86_400)

    @model_validator(mode="after")
    def _names_a_source(self) -> Self:
        if self.clip_id is None and self.url is None:
            raise ValueError("a link goes to a clip or a page")
        return self


class CheckCreate(_Camel):
    scope: UsedScope
    source_app: AppName | None = None
    model_version: Annotated[str, StringConstraints(min_length=1, max_length=120)]
    latency_ms: int = Field(ge=0, le=600_000)
    findings: list[FindingCreate] = Field(max_length=24)
    links: list[SourceLinkCreate] = Field(default_factory=list, max_length=8)

    @model_validator(mode="after")
    def _links_name_findings(self) -> Self:
        if any(link.finding >= len(self.findings) for link in self.links):
            raise ValueError("a link names a finding that isn't there")
        return self


class CheckCreated(_Camel):
    check_id: UUID
    #: In the order of `findings`; a finding naming none of the student's lines isn't stored and
    #: has no id (null).
    finding_ids: list[UUID | None]


# ─── Equivalence (N3) ────────────────────────────────────────────────────────────────────────

MathText = Annotated[PlainText, StringConstraints(min_length=1, max_length=300)]


class ClaimPair(_Camel):
    note: MathText
    screen: MathText


class EquivalenceRequest(_Camel):
    pairs: list[ClaimPair] = Field(min_length=1, max_length=5)


class EquivalenceResponse(_Camel):
    verdicts: list[Literal["equivalent", "different", "unknown"]]


# ─── Resolution (N5) ─────────────────────────────────────────────────────────────────────────

FindingStatus = Literal[
    "open", "resolved_fixed", "resolved_student_right", "dismissed", "explained"
]


class FindingView(_Camel):
    """A stored finding, as its owner reads it back (to resolve it, or mark it again)."""

    id: UUID
    check_id: UUID
    type: FindingType
    note_line_ids: list[UUID]
    page_id: UUID | None
    note_quote: str | None
    screen_snippet: str
    question: str | None
    explanation: str
    concept_hint: str | None
    concept_id: UUID | None
    confidence: float
    source_conflict: bool
    status: FindingStatus
    #: The course of the check's scope, when it was a course's notes (for learner evidence).
    course_id: UUID | None


class FindingUpdate(_Camel):
    """How a finding was resolved. It can't be reopened, and every outcome is final."""

    status: Literal["resolved_fixed", "resolved_student_right", "dismissed", "explained"]
    concept_id: UUID | None = None
