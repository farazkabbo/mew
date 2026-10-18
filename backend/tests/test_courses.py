import json
from collections.abc import Callable
from typing import Any
from uuid import UUID, uuid4

import httpx
import pytest
from fastapi.testclient import TestClient
from pydantic import BaseModel

from mew_api.checker.sandbox import CheckerPool
from mew_api.config import Settings
from mew_api.courses.chunking import TextChunk, chunk_pages, looks_like_heading
from mew_api.courses.concepts import ConceptGraph, ExtractedConcept, clean, heuristic_concepts
from mew_api.courses.embeddings import LexicalEmbedder
from mew_api.courses.ingest import IngestJob, IngestTools, run_ingestion
from mew_api.courses.llm import GeminiLlm, LlmError, gemini_schema
from mew_api.courses.models import NewChunk, Source
from mew_api.courses.pdf import PdfError, encode_png_gray, parse_pdf
from mew_api.courses.store import MemoryCourseStore
from mew_api.courses.supabase_store import StoreError, SupabaseCourseStore
from mew_api.main import create_app

from .conftest import INTERNAL_SECRET, internal_headers
from .pdfgen import CHAPTER, make_pdf

#: The test PDF font encodes "'" as a typographic apostrophe, which pdfium returns as such.
CURLY_APOSTROPHE = chr(0x2019)


class InlinePool(CheckerPool):
    """Runs sandboxed work in-process (fast tests; the real sandbox is tested in test_check)."""

    def run(self, fn: Callable[..., Any], *args: Any, timeout: float) -> Any:
        return fn(*args)


# ─── PDF parsing ──────────────────────────────────────────────────────────────────────────────


def test_parses_text_per_page_and_renders_scanned_pages() -> None:
    pages = parse_pdf(make_pdf(CHAPTER))
    assert [p["number"] for p in pages] == [1, 2, 3, 4]
    assert "Newton" in pages[1]["text"]
    assert pages[0]["image"] is None
    # The empty page looks scanned: it's rendered as a PNG for OCR.
    image = pages[3]["image"]
    assert image is not None and image.startswith(b"\x89PNG\r\n\x1a\n")


@pytest.mark.parametrize(
    ("data", "message"),
    [
        (b"hello", "not a PDF"),
        (b"%PDF-1.4 garbage", "unreadable"),
        (b"%PDF-" + b"0" * (15 * 1024 * 1024 + 1), "too large"),
    ],
    ids=["not-a-pdf", "corrupt", "too-large"],
)
def test_rejects_files_it_cannot_read(data: bytes, message: str) -> None:
    with pytest.raises(PdfError, match=message):
        parse_pdf(data)


def test_png_encoder_writes_a_valid_header() -> None:
    png = encode_png_gray(bytes([0, 128, 255, 0]), 2, 2, 2)
    assert png[:8] == b"\x89PNG\r\n\x1a\n"
    assert png[12:16] == b"IHDR"


# ─── Chunks, concepts, embeddings ─────────────────────────────────────────────────────────────


def test_headings_are_recognised() -> None:
    assert looks_like_heading("3.2 Newton's Laws")
    assert looks_like_heading("Chapter 4 Energy")
    assert looks_like_heading("Friction")
    assert not looks_like_heading("Friction is a force that opposes sliding between surfaces.")
    assert not looks_like_heading("What is a force?")


def test_chunks_never_cross_pages_and_keep_their_heading() -> None:
    pages = parse_pdf(make_pdf(CHAPTER))
    chunks = chunk_pages([(p["number"], p["text"]) for p in pages])
    assert [c.page for c in chunks] == [1, 2, 3]
    # (The test font encodes the apostrophe as a typographic one.)
    headings = [(c.heading or "").replace(CURLY_APOSTROPHE, "'") for c in chunks]
    assert headings == ["3.1 Forces", "3.2 Newton's Laws", "3.3 Friction"]
    assert all(len(c.text) <= 1600 for c in chunks)


def test_heuristic_concepts_follow_the_headings() -> None:
    chunks = [
        TextChunk(1, "3.1 Forces", "A force is a push or a pull."),
        TextChunk(2, "3.2 Newton's laws", "Every action has an equal and opposite reaction."),
        TextChunk(3, "3.2 Newton's laws", "More on the second law."),
    ]
    graph = heuristic_concepts(chunks)
    assert [c.title for c in graph.concepts] == ["Forces", "Newton's laws"]
    assert graph.concepts[1].pages == [2, 3]
    assert graph.concepts[1].prerequisites == [0]


def test_model_graphs_are_cleaned() -> None:
    graph = ConceptGraph(
        subject="physics",
        concepts=[
            ExtractedConcept(
                title="Forces", summary="", pages=[1, 99], prerequisites=[1]
            ),  # forward ref
            ExtractedConcept(title="Newton's laws", summary="", pages=[2], prerequisites=[0]),
            ExtractedConcept(title="forces", summary="", pages=[3], prerequisites=[]),  # duplicate
        ],
    )
    cleaned = clean(graph, {1, 2, 3})
    assert [c.title for c in cleaned.concepts] == ["Forces", "Newton's laws"]
    assert cleaned.concepts[0].pages == [1]  # page 99 doesn't exist
    assert cleaned.concepts[0].prerequisites == []  # prerequisites must come earlier
    assert cleaned.concepts[1].prerequisites == [0]


def test_lexical_embeddings_find_the_right_passage() -> None:
    embedder = LexicalEmbedder()
    docs = embedder.embed_documents(
        [
            ("Forces", "A force is a push or a pull measured in newtons."),
            ("Friction", "Friction opposes sliding between surfaces in contact."),
        ]
    )
    query = embedder.embed_query("why does friction slow sliding objects?")
    scores = [sum(a * b for a, b in zip(doc, query, strict=True)) for doc in docs]
    assert scores[1] > scores[0]
    assert abs(sum(v * v for v in docs[0]) - 1) < 1e-9  # unit length


# ─── Gemini wrapper ───────────────────────────────────────────────────────────────────────────


class Answer(BaseModel):
    value: int


class FakeInteractions:
    def __init__(self, outputs: list[str]) -> None:
        self.outputs = outputs
        self.calls: list[dict[str, Any]] = []

    def create(self, **kwargs: Any) -> Any:
        self.calls.append(kwargs)
        return type("Interaction", (), {"output_text": self.outputs.pop(0)})()


def fake_llm(outputs: list[str]) -> tuple[GeminiLlm, FakeInteractions]:
    interactions = FakeInteractions(outputs)
    client = type("Client", (), {"interactions": interactions})()
    return GeminiLlm(client), interactions


def test_structured_calls_never_store_and_retry_invalid_output_once() -> None:
    llm, interactions = fake_llm(["not json", '{"value": 3}'])
    result = llm.structured(model="m", system="s", text="t", schema=Answer, images=[b"png"])
    assert result.value == 3
    assert len(interactions.calls) == 2
    call = interactions.calls[0]
    assert call["store"] is False
    assert call["response_format"]["schema"]["properties"]["value"]["type"] == "integer"
    assert call["input"][1]["type"] == "image"

    bad, _ = fake_llm(["nope", "still nope"])
    with pytest.raises(LlmError):
        bad.structured(model="m", system="s", text="t", schema=Answer)


def test_schemas_are_pruned_to_what_gemini_accepts() -> None:
    schema = gemini_schema(ConceptGraph)
    text = json.dumps(schema)
    assert "maxLength" not in text and "default" not in text
    # Nested array bounds made the real API answer 400 "invalid argument": none are sent.
    assert "maxItems" not in text and "minItems" not in text
    # The parts the model tends to skip are required.
    concept = schema["$defs"]["ExtractedConcept"]
    assert set(concept["required"]) == {"title", "summary", "pages", "prerequisites"}
    assert "concepts" in schema["properties"]


# ─── Ingestion ────────────────────────────────────────────────────────────────────────────────


def ingest(store: MemoryCourseStore, pdf: bytes, llm: GeminiLlm | None = None) -> UUID:
    store.ensure_profile("u")
    course = store.create_course("u", "Mechanics")
    source = Source(
        id=uuid4(),
        course_id=course.id,
        kind="pdf",
        title="Mechanics",
        embedding_model="lexical-hash-v1",
    )
    store.add_source("u", source)
    run_ingestion(
        IngestJob(user="u", course_id=course.id, source_id=source.id, title="Mechanics", pdf=pdf),
        IngestTools(
            store=store,
            embedder=LexicalEmbedder(),
            llm=llm,
            ocr_model="ocr",
            concept_model="concepts",
            pool=InlinePool(),
        ),
    )
    return course.id


def test_ingestion_builds_a_course_without_a_model() -> None:
    store = MemoryCourseStore()
    course_id = ingest(store, make_pdf(CHAPTER))
    course = store.get_course("u", course_id)
    assert course is not None and course.status == "review"
    assert course.status_detail == "3 concepts from 4 pages"
    concepts = store.list_concepts("u", course_id)
    titles = [c.title.replace(CURLY_APOSTROPHE, "'") for c in concepts]
    assert titles == ["Forces", "Newton's Laws", "Friction"]
    assert [c.source_pages for c in concepts] == [[1], [2], [3]]
    assert len(store.list_edges("u", course_id)) == 2  # a chain: each builds on the last


def test_ingestion_uses_the_model_for_concepts_and_scanned_pages() -> None:
    graph = {
        "subject": "physics",
        "concepts": [
            {"title": "Forces", "summary": "Pushes and pulls.", "pages": [1], "prerequisites": []},
            {
                "title": "Newton's third law",
                "summary": "Pairs.",
                "pages": [2],
                "prerequisites": [0],
            },
            {"title": "Momentum", "summary": "From the scan.", "pages": [4], "prerequisites": [0]},
        ],
    }
    llm, interactions = fake_llm(
        [
            json.dumps({"text": "4.1 Momentum\nMomentum is mass times velocity, p = m v."}),
            json.dumps(graph),
        ]
    )
    store = MemoryCourseStore()
    course_id = ingest(store, make_pdf(CHAPTER), llm)
    assert interactions.calls[0]["input"][1]["type"] == "image"  # page 4 was OCR'd
    concepts = store.list_concepts("u", course_id)
    assert [c.title for c in concepts] == ["Forces", "Newton's third law", "Momentum"]
    hits = store.match_chunks(
        "u", course_id, LexicalEmbedder().embed_query("momentum mass velocity"), 1
    )
    assert hits[0].page == 4


def test_ingestion_reports_unreadable_files_without_leaking_details() -> None:
    store = MemoryCourseStore()
    course_id = ingest(store, b"%PDF-1.4 not really")
    course = store.get_course("u", course_id)
    assert course is not None and course.status == "failed"
    assert course.status_detail is not None and course.status_detail.startswith(
        "Couldn't read that PDF"
    )


# ─── Routes (local mode) ──────────────────────────────────────────────────────────────────────


@pytest.fixture
def dev_client() -> TestClient:
    settings = Settings(
        _env_file=None,
        app_env="development",
        internal_api_secret=INTERNAL_SECRET,
        allowed_hosts=("testserver",),
    )
    app = create_app(settings, None, warm_checker=False)
    app.state.ingest_pool = InlinePool()
    return TestClient(app)


LOCAL = {**internal_headers(), "X-Mew-Local-User": "local"}


def upload(client: TestClient, data: bytes, **headers: str) -> httpx.Response:
    response: httpx.Response = client.post(
        "/v1/courses",
        params={"title": "Forces and motion"},
        content=data,
        headers={**LOCAL, "Content-Type": "application/pdf", **headers},
    )
    return response


def test_upload_review_and_retrieve_in_local_mode(dev_client: TestClient) -> None:
    created = upload(dev_client, make_pdf(CHAPTER))
    assert created.status_code == 202
    course_id = created.json()["id"]

    # The job ran after the response (TestClient runs background tasks before returning).
    detail = dev_client.get(f"/v1/courses/{course_id}", headers=LOCAL).json()
    assert detail["course"]["status"] == "review"
    concepts = detail["concepts"]
    assert len(concepts) == 3
    assert detail["sources"][0]["storage_path"].startswith("local/")

    # Scope review: merge the second concept into the first, drop the last, rename.
    first, second, third = (c["id"] for c in concepts)
    reviewed = dev_client.post(
        f"/v1/courses/{course_id}/review",
        json={
            "merges": [{"into": first, "sources": [second]}],
            "order": [first],
            "titles": {first: "Forces and Newton's laws"},
        },
        headers=LOCAL,
    ).json()
    assert [c["title"] for c in reviewed["concepts"]] == ["Forces and Newton's laws"]
    assert reviewed["concepts"][0]["source_pages"] == [1, 2]
    assert reviewed["edges"] == []
    assert third not in {c["id"] for c in reviewed["concepts"]}

    ready = dev_client.patch(
        f"/v1/courses/{course_id}",
        json={"status": "ready", "exam_date": "2026-12-04"},
        headers=LOCAL,
    ).json()
    assert ready["course"]["status"] == "ready"

    hits = dev_client.post(
        f"/v1/courses/{course_id}/retrieve",
        json={"query": "what opposes sliding?", "k": 2},
        headers=LOCAL,
    ).json()["chunks"]
    assert hits[0]["page"] == 3
    assert hits[0]["source_title"] == "Forces and motion"

    lesson = dev_client.get(
        f"/v1/courses/{course_id}/concepts/{first}/lesson", headers=LOCAL
    ).json()
    assert lesson["generated"] is False  # no model key: the summary and a source passage
    assert lesson["pages"]


def test_upload_validation(dev_client: TestClient) -> None:
    assert upload(dev_client, b"%PDF-1.4", **{"Content-Type": "text/plain"}).status_code == 415
    assert upload(dev_client, b"hello").status_code == 422
    big = b"%PDF-" + b"0" * (15 * 1024 * 1024)
    assert upload(dev_client, big).status_code == 413


def test_courses_are_private_and_local_mode_is_development_only(
    dev_client: TestClient, settings: Settings
) -> None:
    created = upload(dev_client, make_pdf(CHAPTER)).json()
    # Without the local-user marker (or a token) there is no caller.
    assert dev_client.get("/v1/courses", headers=internal_headers()).status_code == 401
    # Unknown or foreign ids look the same: not found.
    assert dev_client.get(f"/v1/courses/{uuid4()}", headers=LOCAL).status_code == 404
    assert created["status"] == "processing"

    # Outside development the local-user marker is ignored.
    production_like = TestClient(create_app(settings, None, warm_checker=False))
    assert production_like.get("/v1/courses", headers=LOCAL).status_code == 401


def test_review_rejects_concepts_from_elsewhere(dev_client: TestClient) -> None:
    course_id = upload(dev_client, make_pdf(CHAPTER)).json()["id"]
    response = dev_client.post(
        f"/v1/courses/{course_id}/review", json={"order": [str(uuid4())]}, headers=LOCAL
    )
    assert response.status_code == 400


# ─── Supabase store ───────────────────────────────────────────────────────────────────────────


def supabase(
    handler: Callable[[httpx.Request], httpx.Response], token: str | None = "user-jwt"
) -> SupabaseCourseStore:
    return SupabaseCourseStore(
        "https://proj.supabase.co",
        api_key="sb_publishable_x" if token else "sb_secret_x",
        user_token=token,
        client=httpx.Client(transport=httpx.MockTransport(handler)),
    )


def test_user_mode_sends_the_users_token_and_scopes_queries() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json=[])

    store = supabase(handler)
    assert store.list_courses("user_1") == []
    request = seen[0]
    assert request.headers["apikey"] == "sb_publishable_x"
    assert request.headers["authorization"] == "Bearer user-jwt"
    assert request.url.params["user_id"] == "eq.user_1"


def test_service_mode_sets_the_owner_on_every_row_and_never_sends_a_bearer() -> None:
    bodies: list[Any] = []

    def handler(request: httpx.Request) -> httpx.Response:
        bodies.append(json.loads(request.content))
        assert "authorization" not in request.headers
        assert request.headers["apikey"] == "sb_secret_x"
        return httpx.Response(201, json=[{"id": str(uuid4())}])

    store = supabase(handler, token=None)
    store.add_chunks(
        "user_1", uuid4(), uuid4(), [NewChunk(page=1, heading=None, text="x", embedding=[0.5, 0.5])]
    )
    assert bodies[0][0]["user_id"] == "user_1"
    assert bodies[0][0]["embedding"] == "[0.500000,0.500000]"


def test_supabase_failures_become_safe_errors() -> None:
    store = supabase(lambda _: httpx.Response(500, text="internal details"))
    with pytest.raises(StoreError) as error:
        store.list_courses("user_1")
    assert "internal details" not in str(error.value)
    expired = supabase(lambda _: httpx.Response(401, json={"message": "JWT expired"}))
    with pytest.raises(PermissionError):
        expired.list_courses("user_1")
    with pytest.raises(PermissionError):
        expired.upload("user_1", "user_2/x.pdf", b"%PDF")  # never outside the user's folder
