"""Wire models for clips (camelCase, like packages/shared/src/clips.ts): part of the screen a
student saved to their notebook from the desktop app (Screen Coach S3, decision 9).

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


class ClipCreate(_Camel):
    image: ClipImage
    pixel_ratio: float = Field(ge=0.25, le=8)
    strokes: list[ClipStroke] = Field(max_length=MAX_STROKES)
    source: ClipSource
    ocr_text: Annotated[PlainText, StringConstraints(max_length=OCR_CHARS)]

    @model_validator(mode="after")
    def _ink_is_capped(self) -> "ClipCreate":
        if sum(len(s.points) for s in self.strokes) > MAX_POINTS:
            raise ValueError("too much ink")
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


class ClipPatch(_Camel):
    notebook_page_id: UUID


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
