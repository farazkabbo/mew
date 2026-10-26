"""Reading a notebook PDF with pdfium (K4, docs/NOTEBOOKS_K.md §5 and decision 2).

Everything here runs in the sandboxed ingest worker (a time limit per call, a 1 GB address-space
cap), on untrusted bytes, and returns plain data:
- `inspect_pdf`: how many pages, the outline (its chapters), whether it's password-protected;
- `render_page`: one page as a PNG (2x, capped in pixels), drawn without forms;
- `page_words`: the page's text layer, word by word, with boxes (0-1 of the page, top left).

pdfium here is a build without V8 or XFA (`pypdfium2.version.PDFIUM_INFO.flags` is empty, and a
test keeps it so): PDF JavaScript can't run. Forms are never initialised (no `init_forms`), and
links, attachments and actions are never read.
"""

import struct
import zlib
from typing import TypedDict

import pypdfium2 as pdfium

#: The outline's top level becomes chapters; deeper levels aren't used.
MAX_OUTLINE = 200
OUTLINE_TITLE_CHARS = 200
#: Rendering: 2x the page's points, never more than this many pixels on the long side.
RENDER_SCALE = 2.0
MAX_RENDER_PIXELS = 2400
MAX_WORDS = 5_000
MAX_PAGE_TEXT = 20_000
#: pdfium reports these for characters it made up (no glyph, no text).
NOT_TEXT = (chr(0), chr(0xFFFE))


class PdfReadError(ValueError):
    """The file isn't a PDF we can read; `reason` says why ("encrypted", "too_many_pages"…)."""

    def __init__(self, reason: str, detail: str = "") -> None:
        super().__init__(detail or reason)
        self.reason = reason


class OutlineItem(TypedDict):
    title: str
    #: 0-based page index.
    page_index: int


class Inspected(TypedDict):
    page_count: int
    outline: list[OutlineItem]
    #: Each page's [width, height] in points (pages are laid out before they're drawn).
    page_sizes: list[tuple[float, float]]


class Word(TypedDict):
    text: str
    #: [left, top, right, bottom], 0-1 of the page, from its top left.
    box: tuple[float, float, float, float]


class PageText(TypedDict):
    text: str
    words: list[Word]


def _open(data: bytes) -> pdfium.PdfDocument:
    if not data.startswith(b"%PDF-"):
        raise PdfReadError("not_pdf", "not a PDF")
    try:
        return pdfium.PdfDocument(data)
    except pdfium.PdfiumError as error:
        # A password-protected file fails to open; its trailer names an /Encrypt dictionary.
        if (
            "password" in str(error).lower()
            or b"/Encrypt" in data[-4096:]
            or b"/Encrypt" in data[:4096]
        ):
            raise PdfReadError("encrypted", "password-protected") from None
        raise PdfReadError("unreadable", "unreadable PDF") from None


def inspect_pdf(data: bytes, max_pages: int) -> Inspected:
    document = _open(data)
    try:
        count = len(document)
        if count == 0:
            raise PdfReadError("empty", "no pages")
        if count > max_pages:
            raise PdfReadError("too_many_pages", f"{count} pages (at most {max_pages})")
        outline: list[OutlineItem] = []
        try:
            for item in document.get_toc(max_depth=1):
                if getattr(item, "level", 0) != 0:
                    continue
                dest = item.get_dest()
                index = dest.get_index() if dest is not None else None
                title = " ".join((item.get_title() or "").split())[:OUTLINE_TITLE_CHARS]
                if not title or index is None or not 0 <= index < count:
                    continue
                outline.append({"title": title, "page_index": index})
                if len(outline) >= MAX_OUTLINE:
                    break
        except pdfium.PdfiumError:
            outline = []  # a broken outline is no outline
        outline.sort(key=lambda o: o["page_index"])
        sizes = [document.get_page_size(i) for i in range(count)]
        page_sizes = [(round(w, 1), round(h, 1)) for w, h in sizes]
        return {"page_count": count, "outline": outline, "page_sizes": page_sizes}
    finally:
        document.close()


def render_page(data: bytes, index: int) -> bytes:
    document = _open(data)
    try:
        if not 0 <= index < len(document):
            raise PdfReadError("no_page", "no such page")
        page = document[index]
        try:
            width, height = page.get_size()
            scale = min(RENDER_SCALE, MAX_RENDER_PIXELS / max(width, height, 1))
            # Never forms: they can carry scripts, and the student's ink is the page's layer.
            bitmap = page.render(scale=scale, may_draw_forms=False, rev_byteorder=True)
            try:
                return encode_png_rgb(
                    bytes(bitmap.buffer),
                    bitmap.width,
                    bitmap.height,
                    bitmap.stride,
                    bitmap.n_channels,
                )
            finally:
                bitmap.close()
        finally:
            page.close()
    finally:
        document.close()


def page_words(data: bytes, index: int) -> PageText:
    document = _open(data)
    try:
        if not 0 <= index < len(document):
            raise PdfReadError("no_page", "no such page")
        page = document[index]
        try:
            width, height = page.get_size()
            textpage = page.get_textpage()
            try:
                return _words(textpage, max(width, 1.0), max(height, 1.0))
            finally:
                textpage.close()
        finally:
            page.close()
    finally:
        document.close()


def _words(textpage: pdfium.PdfTextPage, width: float, height: float) -> PageText:
    count = textpage.count_chars()
    text = textpage.get_text_range(0, count) if count > 0 else ""
    words: list[Word] = []
    current: list[str] = []
    box: list[float] | None = None

    def flush() -> None:
        nonlocal box
        if current and box is not None and len(words) < MAX_WORDS:
            left, bottom, right, top = box
            words.append(
                {
                    "text": "".join(current)[:100],
                    "box": (
                        _unit(left / width),
                        _unit(1 - top / height),
                        _unit(right / width),
                        _unit(1 - bottom / height),
                    ),
                }
            )
        current.clear()
        box = None

    for i in range(min(count, len(text))):
        char = text[i]
        if char.isspace() or char in NOT_TEXT:
            flush()
            continue
        left, bottom, right, top = textpage.get_charbox(i)
        current.append(char)
        box = (
            [left, bottom, right, top]
            if box is None
            else [min(box[0], left), min(box[1], bottom), max(box[2], right), max(box[3], top)]
        )
    flush()
    return {"text": _clean(text)[:MAX_PAGE_TEXT], "words": words}


def _unit(value: float) -> float:
    return round(min(1.0, max(0.0, value)), 4)


def _clean(text: str) -> str:
    text = text.replace("\r\n", "\n").replace("\r", "\n").replace("\x0c", "\n")
    return "\n".join(line.rstrip() for line in text.split("\n")).strip()


def encode_png_rgb(raw: bytes, width: int, height: int, stride: int, channels: int) -> bytes:
    """A minimal 8-bit RGB PNG encoder (no imaging library needed). `raw` is RGB or RGBA rows."""
    if channels not in (3, 4):
        raise ValueError("unexpected pixel format")
    rows = bytearray()
    for y in range(height):
        row = raw[y * stride : y * stride + width * channels]
        rows.append(0)
        if channels == 3:
            rows += row
        else:
            rgb = bytearray(width * 3)
            rgb[0::3], rgb[1::3], rgb[2::3] = row[0::4], row[1::4], row[2::4]
            rows += rgb

    def chunk(kind: bytes, payload: bytes) -> bytes:
        body = kind + payload
        return struct.pack(">I", len(payload)) + body + struct.pack(">I", zlib.crc32(body))

    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(bytes(rows), 6))
        + chunk(b"IEND", b"")
    )
