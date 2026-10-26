"""Wire models for clips (camelCase, like packages/shared/src/clips.ts): part of the screen a
student saved to their notebook from the desktop app (Screen Coach S3, decision 9).

A clip can also be a Circle & Ask **entry** (S3.2, decision 11): the explanation the tutor gave
about what the student marked, with the student's marks as their own strokes. Its follow-ups in
the same session are added to it (`EntryAppend`), without a new picture.

Everything is checked again here even though the web app checked it: the image really is a
JPEG of the size it claims, links can't carry secrets, and the amount of ink is capped.
"""

import base64
import binascii
import re
from datetime import datetime
from typing import Annotated, Literal
from urllib.parse import parse_qsl, urlsplit
from uuid import UUID

from pydantic import (
    AfterValidator,
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    field_validator,
    model_validator,
)
from pydantic.alias_generators import to_camel

LONG_SIDE = 2400
MAX_IMAGE_BYTES = 3 * 1024 * 1024
MAX_STROKES = 300
MAX_POINTS_PER_STROKE = 2_000
MAX_POINTS = 30_000
OCR_CHARS = 8_000
#: An entry's turns (a question and its explanation each), and the student's marks.
MAX_TURNS = 12
MAX_STEPS = 5
MAX_MARK_STROKES = 12

_CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
_APP = re.compile(r"^[a-z0-9 ._+()-]+\.exe$")
_HEX = re.compile(r"^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$")
_DOMAIN = re.compile(r"^(?=.{1,253}$)([a-z0-9-]{1,63}\.)+[a-z]{2,63}$")
_YOUTUBE = re.compile(r"^(?:www\.|m\.)?youtube\.com$")


def _plain(text: str) -> str:
    if _CONTROL.search(text):
        raise ValueError("control characters aren't allowed")
    return text


def _clip_url(url: str) -> str:
    """https, a real domain, no credentials or fragment; a query only for a YouTube video."""
    parts = urlsplit(url)
    host = (parts.hostname or "").lower()
    if parts.scheme != "https" or not _DOMAIN.match(host):
        raise ValueError("links must be https to a domain")
    if parts.username or parts.password or parts.fragment or parts.port:
        raise ValueError("links keep only scheme, host and path")
    allowed = {"v", "t"} if _YOUTUBE.match(host) or host == "youtu.be" else set()
    if any(key not in allowed for key, _ in parse_qsl(parts.query, keep_blank_values=True)):
        raise ValueError("links keep only scheme, host and path")
    return url


#: Refuses control characters; for types that put their own constraints first.
plain_text = _plain
PlainText = Annotated[str, AfterValidator(_plain)]
AppName = Annotated[str, StringConstraints(max_length=64, pattern=_APP.pattern)]
HexColor = Annotated[str, StringConstraints(pattern=_HEX.pattern)]
ClipUrl = Annotated[str, StringConstraints(max_length=2000), AfterValidator(_clip_url)]


class _Camel(BaseModel):
    model_config = ConfigDict(extra="forbid", alias_generator=to_camel, populate_by_name=True)


class ClipStroke(_Camel):
    tool: Literal["pen", "highlighter"]
    color: HexColor
    width: float = Field(gt=0, le=100)
    # [x, y, pressure, t]
    points: list[tuple[float, float, float, float]] = Field(
        min_length=1, max_length=MAX_POINTS_PER_STROKE
    )

    @field_validator("points")
    @classmethod
    def _pressure_and_time(
        cls, points: list[tuple[float, float, float, float]]
    ) -> list[tuple[float, float, float, float]]:
        if any(not 0 <= p <= 1 or t < 0 for _, _, p, t in points):
            raise ValueError("pressure is 0 to 1 and time is never negative")
        return points


class ClipSource(_Camel):
    app: AppName
    title: Annotated[PlainText, StringConstraints(min_length=1, max_length=200)] | None = None
    url: ClipUrl | None = None
    timestamp_sec: int | None = Field(default=None, ge=0, le=86_400)
    captured_at: datetime


class ClipImage(_Camel):
    jpeg: str = Field(min_length=1, max_length=4_000_000)
    width: int = Field(ge=1, le=LONG_SIDE)
    height: int = Field(ge=1, le=LONG_SIDE)


class EntryTurn(_Camel):
    """One question and its explanation, as the notebook shows it under the picture."""

    question: Annotated[PlainText, StringConstraints(min_length=1, max_length=500)]
    steps: list[Annotated[PlainText, StringConstraints(min_length=1, max_length=220)]] = Field(
        min_length=1, max_length=MAX_STEPS
    )
    summary: Annotated[PlainText, StringConstraints(min_length=1, max_length=320)]
    follow_up_question: (
        Annotated[PlainText, StringConstraints(min_length=1, max_length=220)] | None
    ) = None


ConceptHint = Annotated[PlainText, StringConstraints(min_length=1, max_length=80)]


SolutionText = Annotated[PlainText, StringConstraints(min_length=1, max_length=500)]
SolutionLatex = Annotated[PlainText, StringConstraints(max_length=200)] | None


class SavedWritten(_Camel):
    text: SolutionText
    latex: SolutionLatex


class SavedStep(_Camel):
    work: Annotated[PlainText, StringConstraints(min_length=1, max_length=120)]
    latex: SolutionLatex
    why: Annotated[PlainText, StringConstraints(min_length=1, max_length=200)]


class SavedYourTurn(_Camel):
    problem: SolutionText
    latex: SolutionLatex
    answer_key: SavedWritten
    skill: Annotated[PlainText, StringConstraints(min_length=1, max_length=80)]


Subject = Literal[
    "math", "physics", "chemistry", "biology", "history", "language", "programming", "other"
]


class CheckQuestion(_Camel):
    """A moment's check question (K8 §4.7; mirrors CheckQuestion in moments.ts). The web server
    verified a maths key before attaching it; its key never goes to the device."""

    kind: Literal["short", "mcq", "work"]
    prompt: Annotated[PlainText, StringConstraints(min_length=1, max_length=300)]
    choices: list[Annotated[PlainText, StringConstraints(min_length=1, max_length=120)]] = Field(
        max_length=4
    )
    answer_key: Annotated[PlainText, StringConstraints(min_length=1, max_length=300)]
    answer_latex: Annotated[PlainText, StringConstraints(max_length=300)] | None
    problem_latex: Annotated[PlainText, StringConstraints(max_length=300)] | None


class MomentMeta(_Camel):
    """What K8 keeps with an entry: the answer's subject and its check question."""

    subject: Subject | None
    check_question: CheckQuestion | None


class SavedSolution(_Camel):
    """A verified worked solution kept with an entry (K7, "just tell me the answer" on screen).
    The web server attaches it from its own record (packages/shared/src/saved-solution.ts)."""

    problem: SavedWritten
    steps: list[SavedStep] = Field(min_length=1, max_length=6)
    final_answer: SavedWritten
    your_turn: SavedYourTurn | None


class EntryPart(_Camel):
    """What makes a new clip an entry: the session, the student's marks, the first turn, and
    the explanation step of each of the clip's tutor strokes."""

    session_id: UUID
    student_strokes: list[ClipStroke] = Field(max_length=MAX_MARK_STROKES)
    turn: EntryTurn
    stroke_steps: list[int] = Field(max_length=MAX_STROKES)
    concept_hints: list[ConceptHint] = Field(max_length=5)
    solution: SavedSolution | None = None
    moment: MomentMeta | None = None

    @field_validator("stroke_steps")
    @classmethod
    def _steps_exist(cls, steps: list[int]) -> list[int]:
        if any(not 0 <= step < MAX_STEPS for step in steps):
            raise ValueError("a stroke's step is one of the turn's steps")
        return steps


class EntryAppend(_Camel):
    """A follow-up in the same session: its turn and its strokes, added to the entry (in the
    entry image's pixels, placed like the first turn's)."""

    session_id: UUID
    turn: EntryTurn
    strokes: list[ClipStroke] = Field(max_length=MAX_STROKES)
    stroke_steps: list[int] = Field(max_length=MAX_STROKES)
    concept_hints: list[ConceptHint] = Field(max_length=5)
    solution: SavedSolution | None = None
    moment: MomentMeta | None = None

    @model_validator(mode="after")
    def _a_step_per_stroke(self) -> "EntryAppend":
        if len(self.stroke_steps) != len(self.strokes):
            raise ValueError("each stroke has its step")
        if any(not 0 <= step < MAX_STEPS for step in self.stroke_steps):
            raise ValueError("a stroke's step is one of the turn's steps")
        return self


class EntryView(_Camel):
    session_id: UUID
    student_strokes: list[ClipStroke]
    turns: list[EntryTurn]
    #: For each of the clip's strokes: [turn, step].
    stroke_steps: list[tuple[int, int]]
    concept_hints: list[str]
    solution: SavedSolution | None = None
    moment: MomentMeta | None = None


# ─── Where it goes (K3) ──────────────────────────────────────────────────────────────────────


class FromScreenPage(_Camel):
    kind: Literal["from_screen"]


class NewPage(_Camel):
    kind: Literal["new"]


class NumberedPage(_Camel):
    kind: Literal["number"]
    number: int = Field(ge=1, le=999)


DestinationPage = Annotated[FromScreenPage | NewPage | NumberedPage, Field(discriminator="kind")]


class DestinationCreate(_Camel):
    """A chapter to make first (the student tapped "Create it and save"), or with `root` a new
    notebook (K8's "+ New notebook: Biology"; the node is then where it stays otherwise)."""

    title: Annotated[
        PlainText, StringConstraints(strip_whitespace=True, min_length=1, max_length=80)
    ]
    root: bool | None = None


class SavedDestination(_Camel):
    """Where a clip goes in the notebook (K3; mirrors SavedDestination in destinations.ts): a node
    of the student's tree and its page. The node id is only ever compared with the student's own
    tree on their device; nothing here trusts it further."""

    node_id: UUID
    page: DestinationPage
    create: DestinationCreate | None = None
    #: The titles it had when chosen ("Physics", "Chapter 5"), for the toast.
    path: list[Annotated[PlainText, StringConstraints(min_length=1, max_length=200)]] | None = (
        Field(default=None, min_length=1, max_length=3)
    )


class ClipCreate(_Camel):
    image: ClipImage
    pixel_ratio: float = Field(ge=0.25, le=8)
    strokes: list[ClipStroke] = Field(max_length=MAX_STROKES)
    source: ClipSource
    ocr_text: Annotated[PlainText, StringConstraints(max_length=OCR_CHARS)]
    entry: EntryPart | None = None
    #: Where the student said to save it (K3); without one, the notebook decides.
    destination: SavedDestination | None = None

    @model_validator(mode="after")
    def _ink_is_capped(self) -> "ClipCreate":
        marks = self.entry.student_strokes if self.entry else []
        if sum(len(s.points) for s in [*self.strokes, *marks]) > MAX_POINTS:
            raise ValueError("too much ink")
        if self.entry and len(self.entry.stroke_steps) != len(self.strokes):
            raise ValueError("each stroke has its step")
        return self

    def image_bytes(self) -> bytes:
        """The decoded JPEG, checked: real JPEG bytes, at most 3 MB, of the size claimed."""
        try:
            data = base64.b64decode(self.image.jpeg, validate=True)
        except (binascii.Error, ValueError):
            raise ValueError("the image isn't base64") from None
        if len(data) > MAX_IMAGE_BYTES:
            raise ValueError("the image is too large")
        size = jpeg_size(data)
        if size is None:
            raise ValueError("the image isn't a JPEG")
        if size != (self.image.width, self.image.height):
            raise ValueError("the image's size doesn't match")
        return data


class ClipCreated(_Camel):
    clip_id: UUID


class ClipView(_Camel):
    """A clip as its owner's page reads it (the image has its own route)."""

    id: UUID
    width: int
    height: int
    pixel_ratio: float
    strokes: list[ClipStroke]
    source: ClipSource
    ocr_text: str
    notebook_page_id: UUID | None
    created_at: datetime
    #: A Circle & Ask entry's explanation; None for an ordinary clip.
    entry: EntryView | None = None
    #: Where it goes in the notebook (K3); None: wherever the notebook is open.
    destination: SavedDestination | None = None


class ClipPatch(_Camel):
    notebook_page_id: UUID


class ClipDestination(_Camel):
    """A saved clip goes somewhere else (K3: "Change", or "save it to …" said afterwards): it
    moves, it's never copied."""

    clip_id: UUID
    destination: SavedDestination


# Start-of-frame markers carry the image size (all SOFn except DHT, JPG and DAC).
_SOF = {0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF}


def jpeg_size(data: bytes) -> tuple[int, int] | None:
    """(width, height) from a JPEG's first frame header; None if it isn't a JPEG."""
    if len(data) < 4 or data[0] != 0xFF or data[1] != 0xD8:
        return None
    at = 2
    while at + 4 <= len(data):
        if data[at] != 0xFF:
            return None
        marker = data[at + 1]
        if marker == 0xFF:
            at += 1
            continue
        if marker == 0x01 or 0xD0 <= marker <= 0xD7:
            at += 2
            continue
        length = int.from_bytes(data[at + 2 : at + 4], "big")
        if length < 2:
            return None
        if marker in _SOF:
            if at + 9 > len(data):
                return None
            height = int.from_bytes(data[at + 5 : at + 7], "big")
            width = int.from_bytes(data[at + 7 : at + 9], "big")
            return (width, height)
        if marker == 0xDA:
            return None
        at += 2 + length
    return None
