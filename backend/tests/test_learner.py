import json
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID, uuid4

import httpx
import pytest
from fastapi.testclient import TestClient

from mew_api.config import Settings
from mew_api.courses.models import NewChunk, NewConcept, Source
from mew_api.courses.store import MemoryCourseStore
from mew_api.courses.supabase_store import SupabaseCourseStore
from mew_api.learner.models import AttemptWrite, FsrsCard
from mew_api.main import create_app

from .conftest import INTERNAL_SECRET, internal_headers
from .pdfgen import CHAPTER, make_pdf
from .test_courses import InlinePool

LOCAL = {**internal_headers(), "X-Mew-Local-User": "local"}
NOW = datetime(2026, 10, 18, 12, tzinfo=UTC)


def card(due: datetime = NOW, reps: int = 0, **extra: Any) -> dict[str, Any]:
    return {
        "due": due.isoformat(),
        "stability": 3.17 if reps else 0,
        "difficulty": 5.0 if reps else 0,
        "elapsed_days": 0,
        "scheduled_days": 3 if reps else 0,
        "learning_steps": 0,
        "reps": reps,
        "lapses": 0,
        "state": 2 if reps else 0,
        "last_review": NOW.isoformat() if reps else None,
        **extra,
    }


@pytest.fixture
def client() -> TestClient:
    settings = Settings(
        _env_file=None,
        app_env="development",
        internal_api_secret=INTERNAL_SECRET,
        allowed_hosts=("testserver",),
    )
    app = create_app(settings, None, warm_checker=False)
    app.state.ingest_pool = InlinePool()
    return TestClient(app)


def course_with_concepts(client: TestClient) -> tuple[str, list[str]]:
    created = client.post(
        "/v1/courses",
        params={"title": "Forces"},
        content=make_pdf(CHAPTER),
        headers={**LOCAL, "Content-Type": "application/pdf"},
    ).json()
    detail = client.get(f"/v1/courses/{created['id']}", headers=LOCAL).json()
    return created["id"], [c["id"] for c in detail["concepts"]]


def test_attempts_and_cards_round_trip_in_local_mode(client: TestClient) -> None:
    course, (first, second, _) = course_with_concepts(client)
    base = f"/v1/courses/{course}"

    # Opening a lesson starts the card once; a second open keeps it.
    for _ in range(2):
        response = client.post(
            f"{base}/explored", json={"concept_id": first, "card": card()}, headers=LOCAL
        )
        assert response.status_code == 204
    # Relative to the real clock: the route compares due dates with "now".
    later = datetime.now(UTC) + timedelta(days=3)
    for evidence in ("with_hint", "independent"):
        response = client.post(
            f"{base}/attempts",
            json={
                "concept_id": first,
                "correct": True,
                "evidence": evidence,
                "source": "quiz",
                "card": card(later, reps=1),
            },
            headers=LOCAL,
        )
        assert response.status_code == 204

    data = client.get(f"{base}/learner", headers=LOCAL).json()
    assert [a["evidence"] for a in data["attempts"]] == ["with_hint", "independent"]
    assert [c["concept_id"] for c in data["cards"]] == [first]
    assert data["cards"][0]["fsrs_state"]["reps"] == 1
    assert data["cards"][0]["due_at"].startswith(later.date().isoformat())

    # A started card is due straight away; the practised one isn't yet.
    started = card(datetime.now(UTC) - timedelta(seconds=1))
    client.post(f"{base}/explored", json={"concept_id": second, "card": started}, headers=LOCAL)
    due = client.get("/v1/learner/due", headers=LOCAL).json()["cards"]
    assert [(c["concept_id"], c["course_title"]) for c in due] == [(second, "Forces")]
    assert due[0]["reps"] == 0 and due[0]["concept_title"]


def test_rejects_concepts_of_other_courses_and_invalid_cards(client: TestClient) -> None:
    course, (concept, *_) = course_with_concepts(client)
    other, _ = course_with_concepts(client)
    attempt = {
        "concept_id": concept,
        "correct": True,
        "evidence": "independent",
        "source": "practice",
        "card": card(),
    }
    # The concept exists, but in another course: not found, like a foreign id.
    assert (
        client.post(f"/v1/courses/{other}/attempts", json=attempt, headers=LOCAL).status_code == 404
    )
    assert (
        client.post(f"/v1/courses/{uuid4()}/attempts", json=attempt, headers=LOCAL).status_code
        == 404
    )
    assert client.get(f"/v1/courses/{uuid4()}/learner", headers=LOCAL).status_code == 404
    invalid: list[dict[str, Any]] = [
        {**attempt, "evidence": "guessed"},
        {**attempt, "card": card(stability=-1)},
        {**attempt, "card": card(note="extra")},
        {**attempt, "card": {**card(), "due": "2026-10-18T12:00:00"}},  # no time zone
        {**attempt, "user_id": "someone_else"},
    ]
    for body in invalid:
        response = client.post(f"/v1/courses/{course}/attempts", json=body, headers=LOCAL)
        assert response.status_code == 422, body
    # No caller, no data.
    assert client.get("/v1/learner/due", headers=internal_headers()).status_code == 401
    assert client.get("/v1/learner/due", params={"limit": 0}, headers=LOCAL).status_code == 422


def test_deleting_a_course_or_concept_forgets_its_learning() -> None:
    store = MemoryCourseStore()
    course = store.create_course("u", "Forces")
    a, b = store.add_concepts(
        "u",
        course.id,
        [
            NewConcept(title="A", summary="", order_index=0, source_pages=[]),
            NewConcept(title="B", summary="", order_index=1, source_pages=[]),
        ],
    )
    for concept in (a, b):
        store.add_attempt(
            "u",
            course.id,
            AttemptWrite(
                concept_id=concept,
                correct=False,
                evidence="independent",
                source="quiz",
                card=FsrsCard.model_validate(card()),
            ),
        )
    # Another user sees nothing.
    assert store.learner_data("v", course.id).attempts == []
    assert store.due_cards("v", NOW + timedelta(days=1), 10) == []

    store.delete_concepts("u", [a])
    assert {x.concept_id for x in store.learner_data("u", course.id).attempts} == {b}
    store.delete_course("u", course.id)
    assert store.learner_data("u", course.id).cards == []


# ─── Supabase store ───────────────────────────────────────────────────────────────────────────


def supabase(handler: Callable[[httpx.Request], httpx.Response]) -> SupabaseCourseStore:
    return SupabaseCourseStore(
        "https://proj.supabase.co",
        api_key="sb_publishable_x",
        user_token="user-jwt",
        client=httpx.Client(transport=httpx.MockTransport(handler)),
    )


def test_supabase_attempt_updates_the_card_or_creates_it() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if request.method == "PATCH":
            return httpx.Response(200, json=[])  # no card yet
        return httpx.Response(201)

    store = supabase(handler)
    concept = uuid4()
    store.add_attempt(
        "user_1",
        UUID(int=1),
        AttemptWrite(
            concept_id=concept,
            correct=True,
            evidence="with_hint",
            source="practice",
            card=FsrsCard.model_validate(card(NOW, reps=1)),
        ),
    )
    insert_attempt, patch, insert_card = seen
    assert insert_attempt.url.path == "/rest/v1/attempts"
    attempt_row = json.loads(insert_attempt.content)[0]
    # User mode: the database fills user_id from the token (and RLS checks it).
    assert "user_id" not in attempt_row and "card" not in attempt_row
    assert attempt_row["evidence"] == "with_hint"
    assert patch.url.params["user_id"] == "eq.user_1"
    assert patch.url.params["concept_id"] == f"eq.{concept}"
    assert insert_card.url.params["on_conflict"] == "concept_id,user_id"
    assert "ignore-duplicates" in insert_card.headers["prefer"]
    assert json.loads(insert_card.content)[0]["due_at"].startswith("2026-10-18T12:00")
    assert all(r.headers["authorization"] == "Bearer user-jwt" for r in seen)


def test_supabase_due_cards_resolve_titles_within_the_user() -> None:
    course, concept = str(uuid4()), str(uuid4())
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        table = request.url.path.rsplit("/", 1)[-1]
        rows = {
            "review_cards": [
                {
                    "course_id": course,
                    "concept_id": concept,
                    "due_at": "2026-10-18T09:00:00+00:00",
                    "fsrs_state": card(reps=2),
                }
            ],
            "courses": [{"id": course, "title": "Mechanics"}],
            "concepts": [{"id": concept, "title": "Friction"}],
        }[table]
        return httpx.Response(200, json=rows)

    due = supabase(handler).due_cards("user_1", NOW, 50)
    assert [(d.course_title, d.concept_title, d.reps) for d in due] == [
        ("Mechanics", "Friction", 2)
    ]
    assert seen[0].url.params["due_at"] == "lte.2026-10-18T12:00:00Z"
    assert all(r.url.params["user_id"] == "eq.user_1" for r in seen)


def test_concepts_belong_to_the_chapters_their_passages_went_to(client: TestClient) -> None:
    """K1 §2.2: a chapter card shows its course progress (decision 53)."""
    store: MemoryCourseStore = client.app.state.local_courses  # type: ignore[attr-defined]
    course = store.create_course("local", "Chemistry").id
    source = uuid4()
    store.add_source(
        "local",
        Source(id=source, course_id=course, kind="pdf", title="chem.pdf", embedding_model="m"),
    )
    chapter_1, chapter_2 = uuid4(), uuid4()
    first, second, loose = store.add_chunks(
        "local",
        course,
        source,
        [
            NewChunk(page=1, heading=None, text="a", embedding=[1.0], notebook_node_id=chapter_1),
            NewChunk(page=9, heading=None, text="b", embedding=[1.0], notebook_node_id=chapter_2),
            NewChunk(page=12, heading=None, text="c", embedding=[1.0]),
        ],
    )
    atoms, bonds, wide = store.add_concepts(
        "local",
        course,
        [
            NewConcept(title=t, summary="", order_index=i, source_pages=[])
            for i, t in enumerate("abc")
        ],
    )
    store.add_concept_sources(
        "local", [(atoms, first), (bonds, first), (bonds, second), (wide, loose)]
    )

    response = client.get(f"/v1/courses/{course}/concept-nodes", headers=LOCAL)
    assert response.status_code == 200
    pairs = {(n["concept_id"], n["notebook_node_id"]) for n in response.json()["nodes"]}
    assert pairs == {
        (str(atoms), str(chapter_1)),
        (str(bonds), str(chapter_1)),
        (str(bonds), str(chapter_2)),
    }
    assert client.get(f"/v1/courses/{uuid4()}/concept-nodes", headers=LOCAL).status_code == 404
