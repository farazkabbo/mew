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

TEXT_CHARS = 300
LINES_PER_SYNC = 200
REMOVED_PER_SYNC = 1000

_CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


def _plain(text: str) -> str:
    if _CONTROL.search(text):
        raise ValueError("control characters aren't allowed")
    return text


PlainText = Annotated[str, AfterValidator(_plain)]
LineText = Annotated[
    PlainText, StringConstraints(strip_whitespace=True, min_length=1, max_length=TEXT_CHARS)
]


class _Camel(BaseModel):
    model_config = ConfigDict(extra="forbid", alias_generator=to_camel, populate_by_name=True)


class NotebookRef(_Camel):
    """The notebook a page belongs to, mirrored so lines can be scoped to it (and its course)."""

    id: UUID
    title: Annotated[
        PlainText, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)
    ]
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
