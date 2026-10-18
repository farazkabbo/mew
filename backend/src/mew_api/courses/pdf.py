"""PDF parsing with pdfium (pypdfium2, BSD-3/Apache-2.0).

The brief suggests PyMuPDF, but it is AGPL-3.0 licensed, which would oblige publishing this
service's source; pdfium does the same job (text per page, page rendering) under permissive
licences.

Uploaded PDFs are untrusted. This module runs inside a sandboxed worker process (see
checker/sandbox.py) with a time and memory limit, and returns plain data.
"""

import struct
import zlib
from typing import TypedDict

import pypdfium2 as pdfium

MAX_BYTES = 15 * 1024 * 1024
MAX_PAGES = 300
#: A page with less text than this is probably scanned (or a diagram): render it for OCR.
OCR_MIN_CHARS = 40
MAX_OCR_PAGES = 20
#: Render scale for OCR (72 dpi x 1.6, about 115 dpi), capped in pixels.
OCR_SCALE = 1.6
MAX_OCR_PIXELS = 2000


class PdfError(ValueError):
    """The upload isn't a PDF we can read (corrupt, encrypted, too big)."""


class ParsedPage(TypedDict):
    number: int
    text: str
    #: Grayscale PNG of the page, when its text layer is (nearly) empty.
    image: bytes | None


def parse_pdf(data: bytes) -> list[ParsedPage]:
    if len(data) > MAX_BYTES:
        raise PdfError("file too large")
    if not data.startswith(b"%PDF-"):
        raise PdfError("not a PDF")
    try:
        document = pdfium.PdfDocument(data)
    except pdfium.PdfiumError as error:
        raise PdfError(f"unreadable PDF ({error})") from None
    try:
        count = len(document)
        if count == 0:
            raise PdfError("no pages")
        if count > MAX_PAGES:
            raise PdfError(f"too many pages ({count} > {MAX_PAGES})")
        pages: list[ParsedPage] = []
        ocr = 0
        for index in range(count):
            page = document[index]
            try:
                textpage = page.get_textpage()
                text = _clean(textpage.get_text_range())
                textpage.close()
                image = None
                if len(text) < OCR_MIN_CHARS and ocr < MAX_OCR_PAGES:
                    image = _render_png(page)
                    ocr += 1
                pages.append({"number": index + 1, "text": text, "image": image})
            finally:
                page.close()
        return pages
    finally:
        document.close()


def _clean(text: str) -> str:
    # pdfium uses \r\n line ends and form feeds; keep paragraphs, drop noise.
    text = text.replace("\r\n", "\n").replace("\r", "\n").replace("\x0c", "\n")
    lines = [line.rstrip() for line in text.split("\n")]
    return "\n".join(lines).strip()


def _render_png(page: pdfium.PdfPage) -> bytes:
    width, height = page.get_size()
    scale = min(OCR_SCALE, MAX_OCR_PIXELS / max(width, height, 1))
    bitmap = page.render(scale=scale, grayscale=True)
    try:
        raw = bytes(bitmap.buffer)
        return encode_png_gray(raw, bitmap.width, bitmap.height, bitmap.stride)
    finally:
        bitmap.close()


def encode_png_gray(raw: bytes, width: int, height: int, stride: int) -> bytes:
    """A minimal 8-bit grayscale PNG encoder (no imaging library needed)."""
    rows = b"".join(b"\x00" + raw[y * stride : y * stride + width] for y in range(height))

    def chunk(kind: bytes, payload: bytes) -> bytes:
        body = kind + payload
        return struct.pack(">I", len(payload)) + body + struct.pack(">I", zlib.crc32(body))

    header = struct.pack(">IIBBBBB", width, height, 8, 0, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(rows, 6))
        + chunk(b"IEND", b"")
    )
