"""Wire models for the handwriting profile (K10; camelCase like shared/src/handwriting.ts)."""

from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, StringConstraints
from pydantic.alias_generators import to_camel

from ..clips.models import PlainText

Text = Annotated[PlainText, StringConstraints(min_length=1, max_length=300)]
OptionalText = Annotated[PlainText, StringConstraints(max_length=300)] | None
#: A base64 PNG: its signature, then base64 only.
PngBase64 = Annotated[
    str, StringConstraints(max_length=120_000, pattern=r"^iVBORw0KGgo[A-Za-z0-9+/]*={0,2}$")
]
#: Samples kept per student; the oldest go first.
SAMPLES_PER_USER = 300


class _Camel(BaseModel):
    model_config = ConfigDict(extra="forbid", alias_generator=to_camel, populate_by_name=True)


class SampleInput(_Camel):
    id: UUID
    text: Text
    latex: OptionalText
    read_as: OptionalText
    source: Literal["calibration", "fix", "confirm", "not_wrong"]
    image: PngBase64


class SampleRequest(_Camel):
    samples: list[SampleInput] = Field(min_length=1, max_length=40)


class Sample(SampleInput):
    created_at: int


class SampleList(_Camel):
    samples: list[Sample]


class Saved(_Camel):
    saved: int


class Deleted(_Camel):
    deleted: int
