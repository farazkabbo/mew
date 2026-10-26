"""Wire models for live annotations (K9; camelCase like packages/shared/src/annotations.ts)."""

from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, StringConstraints
from pydantic.alias_generators import to_camel

from ..clips.models import PlainText

Millis = Annotated[int, Field(ge=0, le=10**14)]


class _Camel(BaseModel):
    model_config = ConfigDict(extra="forbid", alias_generator=to_camel, populate_by_name=True)


class AnnotationUpsert(_Camel):
    """One mark as the device sends it: what it was and how it ended, never its strokes. The
    recognised text comes only when the student lets neb keep their notes' text."""

    id: UUID
    page_id: UUID
    line_id: UUID
    mark_kind: Literal["tick", "error", "missing", "margin", "unsure"]
    verdict: Literal["correct", "incorrect", "unknown"]
    checker_method: Literal["math", "chemistry", "code", "rubric", "coach", "reading"]
    recognized_text: Annotated[PlainText, StringConstraints(max_length=500)] | None
    confidence: float | None = Field(ge=0, le=1)
    stroke_group_id: UUID
    note: Annotated[PlainText, StringConstraints(max_length=32)] | None
    created_at: Millis
    resolved_at: Millis | None
    dismissed_as: Literal["not_wrong", "hidden"] | None
    evidence: Literal["independent", "with_hint", "after_explanation"] | None


class AnnotationSync(_Camel):
    annotations: list[AnnotationUpsert] = Field(min_length=1, max_length=50)


class AnnotationSyncResult(_Camel):
    saved: int
