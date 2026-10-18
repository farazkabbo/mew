"""Splitting page text into retrieval chunks. Chunks never cross pages, so a citation is exact."""

import re
from dataclasses import dataclass

TARGET_CHARS = 1000
MAX_CHARS = 1600
MIN_CHARS = 40

_NUMBERED = re.compile(r"^(?:chapter\s+\d+|\d+(?:\.\d+){0,3}\.?)\s+\S", re.IGNORECASE)


@dataclass(frozen=True)
class TextChunk:
    page: int
    heading: str | None
    text: str


def looks_like_heading(line: str) -> bool:
    """A short line that reads like a title: "3.2 Newton's laws", "Chapter 4 Energy", "Friction"."""
    line = line.strip()
    if not (2 <= len(line) <= 80) or line.endswith((".", ",", ";", ":")):
        return False
    words = line.split()
    if len(words) > 10:
        return False
    if _NUMBERED.match(line):
        return True
    letters = [w for w in words if w[0].isalpha()]
    if not letters:
        return False
    capitalised = sum(1 for w in letters if w[0].isupper()) / len(letters)
    return capitalised >= 0.6 and len(words) <= 6 and not line.endswith("?")


def chunk_pages(pages: list[tuple[int, str]]) -> list[TextChunk]:
    """Chunks of about TARGET_CHARS, each tagged with the nearest heading above it. Works line by
    line (PDF text rarely has blank lines between paragraphs); never crosses a page."""
    builder = _ChunkBuilder()
    for number, text in pages:
        for line in text.splitlines():
            stripped = line.strip()
            if not stripped:
                continue
            if looks_like_heading(stripped):
                builder.heading(number, stripped)
            else:
                builder.add(number, stripped)
        builder.flush()
    return builder.chunks


class _ChunkBuilder:
    def __init__(self) -> None:
        self.chunks: list[TextChunk] = []
        self.current_heading: str | None = None
        self.buffer: list[str] = []
        self.size = 0
        self.page = 0

    def heading(self, page: int, text: str) -> None:
        self.flush()
        self.current_heading = text
        self.page = page

    def add(self, page: int, line: str) -> None:
        for piece in _split_long(line):
            if self.size + len(piece) > TARGET_CHARS and self.size > 0:
                self.flush()
            self.page = page
            self.buffer.append(piece)
            self.size += len(piece) + 1

    def flush(self) -> None:
        body = " ".join(self.buffer).strip()
        if len(body) >= MIN_CHARS:
            self.chunks.append(TextChunk(self.page, self.current_heading, body[:MAX_CHARS]))
        self.buffer = []
        self.size = 0


def _split_long(paragraph: str) -> list[str]:
    """Splits an over-long paragraph at sentence ends."""
    if len(paragraph) <= MAX_CHARS:
        return [paragraph]
    sentences = re.split(r"(?<=[.!?])\s+", paragraph)
    pieces: list[str] = []
    current = ""
    for sentence in sentences:
        if current and len(current) + len(sentence) > TARGET_CHARS:
            pieces.append(current)
            current = ""
        current = f"{current} {sentence}".strip()
        while len(current) > MAX_CHARS:
            pieces.append(current[:MAX_CHARS])
            current = current[MAX_CHARS:]
    if current:
        pieces.append(current)
    return pieces
