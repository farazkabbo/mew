import struct
import zlib

import pypdfium2.version
import pytest

from mew_api.pdfs.reader import PdfReadError, inspect_pdf, page_words, render_page

from .pdfgen import CHAPTER, make_pdf

BOOK = make_pdf(
    [
        ["Chapter 1 Motion", "Speed is distance over time."],
        ["More motion"],
        ["Chapter 2 Forces"],
        [],
    ],
    outline=[("Chapter 1 Motion", 0), ("Chapter 2  Forces", 2)],
)


def test_pdfium_runs_no_javascript() -> None:
    # A build with V8 or XFA would list them: PDF JavaScript can never run here.
    assert pypdfium2.version.PDFIUM_INFO.flags == ()


def test_reads_the_page_count_and_the_outline_as_chapters() -> None:
    assert inspect_pdf(BOOK, max_pages=400) == {
        "page_count": 4,
        "outline": [
            {"title": "Chapter 1 Motion", "page_index": 0},
            {"title": "Chapter 2 Forces", "page_index": 2},
        ],
        "page_sizes": [(612.0, 792.0)] * 4,
    }
    assert inspect_pdf(make_pdf(CHAPTER), max_pages=400)["outline"] == []


@pytest.mark.parametrize(
    ("data", "reason"),
    [
        (b"GIF89a", "not_pdf"),
        (b"%PDF-1.4\nnonsense", "unreadable"),
        (make_pdf([["Secret"]], encrypted=True), "encrypted"),
    ],
)
def test_refuses_what_it_cant_read(data: bytes, reason: str) -> None:
    with pytest.raises(PdfReadError) as error:
        inspect_pdf(data, max_pages=400)
    assert error.value.reason == reason


def test_refuses_too_many_pages() -> None:
    with pytest.raises(PdfReadError) as error:
        inspect_pdf(BOOK, max_pages=3)
    assert error.value.reason == "too_many_pages"


def test_renders_a_page_as_a_png_at_twice_its_size() -> None:
    png = render_page(BOOK, 0)
    assert png.startswith(b"\x89PNG\r\n\x1a\n")
    width, height, depth, color = struct.unpack(">IIBB", png[16:26])
    assert (width, height, depth, color) == (1224, 1584, 8, 2)  # 612 x 792 points, RGB
    # The pixels decode (one filter byte per row of RGB).
    start = png.index(b"IDAT") + 4
    length = struct.unpack(">I", png[start - 8 : start - 4])[0]
    assert len(zlib.decompress(png[start : start + length])) == height * (1 + width * 3)
    with pytest.raises(PdfReadError):
        render_page(BOOK, 9)


def test_reads_the_text_layer_word_by_word_with_boxes() -> None:
    page = page_words(BOOK, 0)
    assert page["text"].startswith("Chapter 1 Motion")
    words = [w["text"] for w in page["words"]]
    assert words[:3] == ["Chapter", "1", "Motion"]
    left, top, right, bottom = page["words"][0]["box"]
    # Near the top left of the page (the text starts at 56, 760 points).
    assert 0.05 < left < right < 0.3 and 0 < top < bottom < 0.1
    blank = page_words(BOOK, 3)
    assert blank["text"] == "" and blank["words"] == []
