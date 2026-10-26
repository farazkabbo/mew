from typing import Any
from uuid import UUID, uuid4

import httpx
import pytest
from fastapi.testclient import TestClient

from mew_api.config import Settings
from mew_api.main import create_app

from .conftest import INTERNAL_SECRET, internal_headers
from .pdfgen import CHAPTER, make_pdf
from .test_courses import InlinePool

LOCAL = {**internal_headers(), "X-Mew-Local-User": "local"}
BOOK = make_pdf(
    [
        ["Chapter 1 Motion", "Speed is distance over time.", "Velocity has a direction."],
        ["Acceleration is how fast velocity changes."],
        ["Chapter 2 Forces", "A force is a push or a pull. Forces are measured in newtons."],
        ["Friction opposes sliding between surfaces in contact."],
    ],
    outline=[("Chapter 1 Motion", 0), ("Chapter 2 Forces", 2)],
)


@pytest.fixture
def client() -> TestClient:
    settings = Settings(
        _env_file=None,
        app_env="development",
        internal_api_secret=INTERNAL_SECRET,
        allowed_hosts=("testserver",),
        pdf_max_pages=10,
    )
    app = create_app(settings, None, warm_checker=False)
    app.state.ingest_pool = InlinePool()
    return TestClient(app)


def upload(client: TestClient, data: bytes, name: str = "Physics 101.pdf") -> httpx.Response:
    response: httpx.Response = client.post(
        "/v1/pdfs",
        params={"fileName": name},
        content=data,
        headers={**LOCAL, "Content-Type": "application/pdf"},
    )
    return response


def test_imports_a_pdf_with_its_outline_and_serves_its_pages(client: TestClient) -> None:
    created = upload(client, BOOK, "C:\\Users\\me\\Books\\Physics 101.pdf")
    assert created.status_code == 201
    info = created.json()
    assert info["fileName"] == "Physics 101.pdf"  # never a folder
    assert info["pageCount"] == 4
    assert info["outline"] == [
        {"title": "Chapter 1 Motion", "pageIndex": 0},
        {"title": "Chapter 2 Forces", "pageIndex": 2},
    ]
    assert info["pageSizes"] == [[612.0, 792.0]] * 4
    pdf_id = info["pdfId"]
    later = client.get(f"/v1/pdfs/{pdf_id}", headers=LOCAL).json()
    assert later["pageCount"] == 4 and "pageSizes" not in later

    image = client.get(f"/v1/pdfs/{pdf_id}/pages/0/image", headers=LOCAL)
    assert image.status_code == 200
    assert image.headers["content-type"] == "image/png"
    assert image.content.startswith(b"\x89PNG")
    assert "no-store" in image.headers["cache-control"]

    text = client.get(f"/v1/pdfs/{pdf_id}/pages/2/text", headers=LOCAL).json()
    assert text["text"].startswith("Chapter 2 Forces")
    assert text["words"][0]["text"] == "Chapter"

    assert client.get(f"/v1/pdfs/{pdf_id}/pages/9/image", headers=LOCAL).status_code == 404
    assert client.get(f"/v1/pdfs/{pdf_id}/pages/-1/text", headers=LOCAL).status_code == 422


@pytest.mark.parametrize(
    ("data", "status", "message"),
    [
        (b"GIF89a not a pdf", 422, "isn't a PDF"),
        (make_pdf([["Secret"]], encrypted=True), 422, "password-protected"),
        (make_pdf([["page"]] * 11), 422, "too many pages"),
    ],
)
def test_refuses_files_it_cant_import(
    client: TestClient, data: bytes, status: int, message: str
) -> None:
    response = upload(client, data)
    assert response.status_code == status
    assert message in response.json()["detail"]


def test_needs_a_pdf_body_and_a_caller(client: TestClient) -> None:
    assert (
        client.post(
            "/v1/pdfs", params={"fileName": "x.pdf"}, content=BOOK, headers=LOCAL
        ).status_code
        == 415
    )
    assert (
        client.post(
            "/v1/pdfs",
            params={"fileName": "x.pdf"},
            content=BOOK,
            headers={**internal_headers(), "Content-Type": "application/pdf"},
        ).status_code
        == 401
    )


def test_keeps_each_students_pdfs_apart(client: TestClient) -> None:
    pdf_id = upload(client, BOOK).json()["pdfId"]
    other = {**internal_headers(), "X-Mew-Local-User": "someone_else"}
    # The local marker only names "local" in development; any other caller sees nothing.
    for path in (f"/v1/pdfs/{pdf_id}", f"/v1/pdfs/{pdf_id}/pages/0/image"):
        assert client.get(path, headers=other).status_code in (401, 404)
    assert client.get(f"/v1/pdfs/{uuid4()}", headers=LOCAL).status_code == 404


def test_becomes_course_material_scoped_to_the_chapters(client: TestClient) -> None:
    pdf_id = upload(client, BOOK).json()["pdfId"]
    ch1, ch2 = uuid4(), uuid4()
    body: dict[str, Any] = {
        "title": "Physics",
        "sections": [
            {"nodeId": str(ch1), "firstPage": 1, "lastPage": 2},
            {"nodeId": str(ch2), "firstPage": 3, "lastPage": 4},
        ],
    }
    started = client.post(f"/v1/pdfs/{pdf_id}/course", json=body, headers=LOCAL)
    assert started.status_code == 202
    course_id = UUID(started.json()["courseId"])
    # The background job ran (the test client runs it before returning).
    course = client.get(f"/v1/courses/{course_id}", headers=LOCAL).json()
    assert course["course"]["status"] in ("review", "failed")
    store = client.app.state.local_courses  # type: ignore[attr-defined]
    chunks = list(store._data("local").chunks.values())
    assert chunks, "the PDF's text became passages"
    by_page = {c.page: c.notebook_node_id for c in chunks}
    assert all(by_page[p] == ch1 for p in by_page if p <= 2)
    assert all(by_page[p] == ch2 for p in by_page if p >= 3)
    # The PDF remembers its course.
    assert client.get(f"/v1/pdfs/{pdf_id}", headers=LOCAL).json()["courseId"] == str(course_id)

    # Into an existing course; a section that ends before it starts is refused.
    again = client.post(
        f"/v1/pdfs/{pdf_id}/course", json={**body, "courseId": str(course_id)}, headers=LOCAL
    )
    assert again.json()["courseId"] == str(course_id)
    bad = {**body, "sections": [{"nodeId": str(ch1), "firstPage": 3, "lastPage": 1}]}
    assert client.post(f"/v1/pdfs/{pdf_id}/course", json=bad, headers=LOCAL).status_code == 422
    missing = {**body, "courseId": str(uuid4())}
    assert client.post(f"/v1/pdfs/{pdf_id}/course", json=missing, headers=LOCAL).status_code == 404


def test_a_scanned_page_is_still_a_page(client: TestClient) -> None:
    pdf_id = upload(client, make_pdf(CHAPTER)).json()["pdfId"]
    blank = client.get(f"/v1/pdfs/{pdf_id}/pages/3/text", headers=LOCAL).json()
    assert blank == {"text": "", "words": []}
    assert client.get(f"/v1/pdfs/{pdf_id}/pages/3/image", headers=LOCAL).status_code == 200
