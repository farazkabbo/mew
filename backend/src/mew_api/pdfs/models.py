"""Notebook PDF payloads (mirrored by zod schemas in packages/shared/src/pdfs.ts)."""

from typing import Annotated
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator
from pydantic.alias_generators import to_camel


class _Camel(BaseModel):
    model_config = ConfigDict(extra="forbid", alias_generator=to_camel, populate_by_name=True)


class PdfOutlineItem(_Camel):
    title: Annotated[str, StringConstraints(min_length=1, max_length=200)]
    #: 0-based page index.
    page_index: int = Field(ge=0)


class PdfInfo(_Camel):
    """An imported PDF, as the student's page reads it."""

    pdf_id: UUID
    file_name: str
    page_count: int
    outline: list[PdfOutlineItem]
    course_id: UUID | None = None
    #: Each page's [width, height] in points: only right after the import (pages are laid out
    #: then, before they're drawn).
    page_sizes: list[tuple[float, float]] | None = None


class PdfWord(_Camel):
    text: str
    #: [left, top, right, bottom], 0-1 of the page, from its top left.
    box: tuple[float, float, float, float]


class PdfPageText(_Camel):
    text: str
    words: list[PdfWord]


class PdfSection(_Camel):
    """Pages (1-based, inclusive) that went to one notebook node: its course passages say so."""

    node_id: UUID
    first_page: int = Field(ge=1)
    last_page: int = Field(ge=1)

    @model_validator(mode="after")
    def _in_order(self) -> "PdfSection":
        if self.last_page < self.first_page:
            raise ValueError("a section ends after it starts")
        return self


class PdfCourseRequest(_Camel):
    """ "Use as course material" (§5.1): into an existing course, or a new one with `title`."""

    course_id: UUID | None = None
    title: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=120)]
    sections: list[PdfSection] = Field(min_length=1, max_length=200)


class PdfCourseStarted(_Camel):
    course_id: UUID
