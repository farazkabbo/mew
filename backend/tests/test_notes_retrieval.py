import json
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

import httpx
import pytest
from fastapi.testclient import TestClient

from mew_api.config import Settings
from mew_api.courses.embeddings import LEXICAL_MODEL, LexicalEmbedder
from mew_api.main import create_app
from mew_api.notes import eval_retrieval
from mew_api.notes.embedding import embed_changed_lines
from mew_api.notes.models import (
    NotebookRef,
    NoteLineUpsert,
    NotePageSync,
    RetrieveRequest,
    RetrieveScope,
    ScreenBlock,
)
from mew_api.notes.retrieval import (
    MAX_LINES,
    Hit,
    NotebookInfo,
    StoredNoteLine,
    best_pages,
    ladder_from,
    prefer_near,
    rank_hits,
    retrieve,
    search_terms,
    select_context,
)
from mew_api.notes.store import MemoryNoteLineStore, SupabaseNoteLineStore

from .conftest import INTERNAL_SECRET, internal_headers
from .test_devices import LOCAL, link_device

EVALS = Path(__file__).resolve().parents[2] / "frontend" / "evals" / "notes-check"
COURSE = UUID("99999999-9999-4999-8999-999999999999")


def blocks(*texts: str) -> list[ScreenBlock]:
    return [ScreenBlock(block_id=f"b{i}", text=t) for i, t in enumerate(texts, 1)]


# ─── Pure parts ──────────────────────────────────────────────────────────────────────────────


def test_search_terms_keep_the_words_that_say_what_the_screen_is_about() -> None:
    terms = search_terms(
        blocks(
            "How enzymes work",
            "Enzymes lower the activation energy of a reaction. Example from 1914, page 3.",
        )
    )
    assert terms[0] == "enzymes"  # most frequent first
    assert {"activation", "energy", "reaction", "1914"} <= set(terms)
    assert not {"how", "the", "of", "a", "example", "page", "3"} & set(terms)


def hit(
    similarity: float | None = None,
    word_rank: float | None = None,
    page: UUID | None = None,
    index: int = 0,
) -> Hit:
    return Hit(uuid4(), page or uuid4(), index, similarity, word_rank)


def test_only_related_hits_are_ranked_and_both_searches_count() -> None:
    both = hit(similarity=0.7, word_rank=0.2)
    meaning = hit(similarity=0.65)
    word = hit(word_rank=0.1)
    weak = hit(similarity=0.3)
    ranked = rank_hits([weak, word, meaning, both], "gemini-embedding-2")
    assert next(h for h, _ in ranked) == both
    assert {h for h, _ in ranked} == {both, meaning, word}
    # Hashed-word embeddings score lower when related: a lower threshold applies.
    assert rank_hits([hit(similarity=0.2)], LEXICAL_MODEL)


def test_pages_with_a_stray_hit_are_left_out() -> None:
    main, stray = uuid4(), uuid4()
    ranked = rank_hits(
        [hit(similarity=0.9 - i / 100, word_rank=1, page=main) for i in range(5)]
        + [hit(word_rank=0.1, page=stray)],
        "gemini-embedding-2",
    )
    assert best_pages(ranked) == [main]


def line(page: UUID, index: int, line_id: UUID | None = None) -> StoredNoteLine:
    return StoredNoteLine(
        line_id or uuid4(),
        page,
        index,
        (0, index * 30, 200, 24),
        "ink",
        None,
        f"line {index}",
        None,
        0.9,
    )


def test_context_is_each_hit_with_three_neighbours_in_reading_order() -> None:
    page = uuid4()
    lines = [line(page, i) for i in range(12)]
    target = lines[6]
    ranked = [(Hit(target.id, page, 6, 0.9, None), 1.0)]
    context = select_context(ranked, lines, [page])
    assert [c.line_index for c in context] == [3, 4, 5, 6, 7, 8, 9]
    assert [c.hit for c in context].count(True) == 1


def test_context_is_capped_closest_to_the_hits_first() -> None:
    pages = [uuid4() for _ in range(4)]
    lines = [line(p, i) for p in pages for i in range(60)]
    ranked = [
        (Hit(item.id, item.page_id, item.line_index, 0.9, None), 1.0)
        for item in lines
        if item.line_index % 7 == 3
    ]
    context = select_context(ranked, lines, pages)
    assert len(context) == MAX_LINES
    assert all(c.hit for c in context if c.line_index % 7 == 3)


# ─── Scope and the whole retrieval, on the local store ──────────────────────────────────────


def store_with(
    *pages: tuple[NotebookRef, list[str]],
) -> tuple[MemoryNoteLineStore, list[list[UUID]]]:
    store = MemoryNoteLineStore()
    ids: list[list[UUID]] = []
    for number, (notebook, texts) in enumerate(pages):
        page_id = uuid4()
        lines = [
            NoteLineUpsert(
                id=uuid4(),
                line_index=i,
                bbox=(0, i * 30, 200, 24),
                source="ink",
                text=t,
                latex=None,
                confidence=0.9,
                content_hash="0a1b2c3d",
            )
            for i, t in enumerate(texts)
        ]
        sync = NotePageSync(notebook=notebook, page_index=number, upsert=lines, remove=[])
        store.sync("u", page_id, sync, embed_changed_lines(lines, {}, LexicalEmbedder()))
        ids.append([item.id for item in lines])
    return store, ids


BIOLOGY = NotebookRef(id=uuid4(), title="Biology", course_id=COURSE)
BIOLOGY_TWO = NotebookRef(id=uuid4(), title="Biology revision", course_id=COURSE)
DIARY = NotebookRef(id=uuid4(), title="Diary", course_id=None)


def ask(store: MemoryNoteLineStore, scope: RetrieveScope, *texts: str) -> Any:
    request = RetrieveRequest(screen=blocks(*texts), scope=scope)
    return retrieve(store, LexicalEmbedder(), "u", request)


def test_default_scope_is_the_course_of_the_notebook_changed_last() -> None:
    store, ids = store_with(
        (DIARY, ["enzymes are cool, said my friend"]),
        (BIOLOGY_TWO, ["enzymes lower activation energy"]),
        (BIOLOGY, ["enzymes are proteins"]),
    )
    found = ask(store, RetrieveScope(kind="default"), "Enzymes lower the activation energy")
    assert found.scope.kind == "course" and found.scope.course_id == COURSE
    assert {item.line_id for item in found.lines} == {ids[1][0], ids[2][0]}  # not the diary
    assert {p.notebook_title for p in found.pages} <= {"Biology", "Biology revision"}


def test_notebook_and_all_scopes() -> None:
    store, ids = store_with((DIARY, ["enzymes at the party"]), (BIOLOGY, ["enzymes are proteins"]))
    only_diary = ask(store, RetrieveScope(kind="notebook", notebook_id=DIARY.id), "enzymes")
    assert [item.line_id for item in only_diary.lines] == [ids[0][0]]
    everything = ask(store, RetrieveScope(kind="all"), "enzymes")
    assert {item.line_id for item in everything.lines} == {ids[0][0], ids[1][0]}


def test_unrelated_notes_mean_no_comparison() -> None:
    store, _ = store_with((BIOLOGY, ["enzymes are proteins"]))
    found = ask(store, RetrieveScope(kind="all"), "The Treaty of Versailles was signed in 1919")
    assert found.related is False and found.lines == [] and found.pages == []


def test_no_notes_at_all_is_not_an_error() -> None:
    found = ask(MemoryNoteLineStore(), RetrieveScope(kind="default"), "anything")
    assert found.related is False


def test_a_clip_checked_against_the_notes_never_matches_itself() -> None:
    store = MemoryNoteLineStore()
    clip, page = uuid4(), uuid4()
    own = NoteLineUpsert(
        id=uuid4(),
        line_index=0,
        bbox=(0, 0, 200, 24),
        source="clip",
        clip_id=clip,
        text="enzymes are not consumed",
        latex=None,
        confidence=1,
        content_hash="0a1b2c3d",
    )
    ink = NoteLineUpsert(
        id=uuid4(),
        line_index=1,
        bbox=(0, 30, 200, 24),
        source="ink",
        text="enzymes are used up",
        latex=None,
        confidence=0.9,
        content_hash="0a1b2c3d",
    )
    sync = NotePageSync(notebook=BIOLOGY, page_index=0, upsert=[own, ink], remove=[])
    store.sync("u", page, sync, embed_changed_lines([own, ink], {}, LexicalEmbedder()))
    request = RetrieveRequest(
        screen=blocks("enzymes are not consumed"),
        scope=RetrieveScope(kind="all"),
        exclude_clip_id=clip,
    )
    found = retrieve(store, LexicalEmbedder(), "u", request)
    assert [item.line_id for item in found.lines] == [ink.id]


def test_words_alone_still_find_notes_when_embedding_fails() -> None:
    class Broken(LexicalEmbedder):
        def embed_query(self, text: str) -> list[float]:
            raise RuntimeError("quota")

    store, ids = store_with((BIOLOGY, ["enzymes lower activation energy"]))
    request = RetrieveRequest(
        screen=blocks("enzymes and activation energy"), scope=RetrieveScope(kind="all")
    )
    found = retrieve(store, Broken(), "u", request)
    assert [item.line_id for item in found.lines] == ids[0]


# ─── The eval (N2 acceptance: ≥ 90% of cases retrieve every relevant line) ──────────────────


def test_retrieval_eval_passes_with_hashed_word_embeddings() -> None:
    results, failures = eval_retrieval.run(EVALS, LexicalEmbedder())
    stats = eval_retrieval.summary(results)
    assert failures == 0
    assert stats["cases"] >= 60
    assert stats["found_all_rate"] >= 0.9, [r.case_id for r in results if not r.found_all]
    assert stats["mean_distractor_lines"] <= 6


# ─── Routes ──────────────────────────────────────────────────────────────────────────────────


@pytest.fixture
def client() -> TestClient:
    settings = Settings(
        _env_file=None,
        app_env="development",
        internal_api_secret=INTERNAL_SECRET,
        allowed_hosts=("testserver",),
    )
    return TestClient(create_app(settings, None, warm_checker=False))


def sync_page(client: TestClient, texts: list[str]) -> None:
    body = {
        "notebook": {"id": str(BIOLOGY.id), "title": "Biology", "courseId": None},
        "pageIndex": 0,
        "upsert": [
            {
                "id": str(uuid4()),
                "lineIndex": i,
                "bbox": [0, i * 30, 200, 24],
                "source": "ink",
                "text": t,
                "latex": None,
                "confidence": 0.9,
                "contentHash": "0a1b2c3d",
            }
            for i, t in enumerate(texts)
        ],
        "remove": [],
    }
    assert (
        client.put(f"/v1/notes/pages/{uuid4()}/lines", json=body, headers=LOCAL).status_code == 200
    )


SCREEN = {
    "screen": [{"blockId": "b1", "text": "Enzymes lower the activation energy"}],
    "scope": {"kind": "default"},
}


def test_the_student_retrieves_their_related_notes(client: TestClient) -> None:
    sync_page(client, ["Enzymes", "enzymes lower activation energy", "unrelated line"])
    response = client.post("/v1/notes/retrieve", json=SCREEN, headers=LOCAL)
    assert response.status_code == 200
    body = response.json()
    assert body["related"] is True and body["scope"]["kind"] == "notebook"
    assert [item["text"] for item in body["lines"]][:2] == [
        "Enzymes",
        "enzymes lower activation energy",
    ]
    assert body["pages"][0]["notebookTitle"] == "Biology"


def test_a_lines_open_live_mark_comes_with_it(client: TestClient) -> None:
    sync_page(client, ["Enzymes", "enzymes lower activation energy"])
    first = client.post("/v1/notes/retrieve", json=SCREEN, headers=LOCAL).json()["lines"]
    marked = next(line for line in first if line["text"] == "enzymes lower activation energy")
    mark = {
        "id": str(uuid4()),
        "pageId": marked["pageId"],
        "lineId": marked["lineId"],
        "markKind": "error",
        "verdict": "incorrect",
        "checkerMethod": "rubric",
        "recognizedText": None,
        "confidence": 0.9,
        "strokeGroupId": str(uuid4()),
        "note": "evidence?",
        "createdAt": 1_790_000_000_000,
        "resolvedAt": None,
        "dismissedAs": None,
        "evidence": None,
    }
    assert (
        client.put("/v1/annotations", json={"annotations": [mark]}, headers=LOCAL).status_code
        == 200
    )
    lines = client.post("/v1/notes/retrieve", json=SCREEN, headers=LOCAL).json()["lines"]
    by_text = {line["text"]: line.get("mark") for line in lines}
    assert by_text == {"Enzymes": None, "enzymes lower activation energy": "error"}
    # Resolved: no longer said about the line.
    done = {**mark, "resolvedAt": 1_790_000_060_000}
    client.put("/v1/annotations", json={"annotations": [done]}, headers=LOCAL)
    lines = client.post("/v1/notes/retrieve", json=SCREEN, headers=LOCAL).json()["lines"]
    assert all(line.get("mark") is None for line in lines)


def test_a_device_retrieves_its_owners_notes_but_never_names_a_scope(client: TestClient) -> None:
    sync_page(client, ["enzymes lower activation energy"])
    token = link_device(client)
    device = {**internal_headers(), "X-Mew-Device-Token": token}
    found = client.post("/v1/notes/device/retrieve", json=SCREEN, headers=device)
    assert found.status_code == 200 and found.json()["related"] is True

    named = {**SCREEN, "scope": {"kind": "notebook", "notebookId": str(BIOLOGY.id)}}
    assert client.post("/v1/notes/device/retrieve", json=named, headers=device).status_code == 422


@pytest.mark.parametrize("token", [None, "mewdt_short", f"mewdt_{'A' * 43}"])
def test_a_device_needs_a_valid_token(client: TestClient, token: str | None) -> None:
    headers = internal_headers()
    if token:
        headers["X-Mew-Device-Token"] = token
    assert client.post("/v1/notes/device/retrieve", json=SCREEN, headers=headers).status_code == 401


@pytest.mark.parametrize(
    "body",
    [
        {"screen": [], "scope": {"kind": "all"}},
        {"screen": [{"blockId": "b1", "text": "x" * 1001}], "scope": {"kind": "all"}},
        {"screen": [{"blockId": "b 1", "text": "x"}], "scope": {"kind": "all"}},
        {
            "screen": [{"blockId": "b1", "text": "x"}, {"blockId": "b1", "text": "y"}],
            "scope": {"kind": "all"},
        },
        {
            "screen": [{"blockId": f"b{i}", "text": "x" * 900} for i in range(10)],
            "scope": {"kind": "all"},
        },
        {"screen": [{"blockId": "b1", "text": "x"}], "scope": {"kind": "notebook"}},
        {
            "screen": [{"blockId": "b1", "text": "x"}],
            "scope": {"kind": "all", "courseId": str(COURSE)},
        },
    ],
    ids=[
        "empty",
        "long-block",
        "block-id",
        "duplicate-block",
        "too-much-text",
        "notebook-without-id",
        "all-with-course",
    ],
)
def test_retrieval_refuses_invalid_requests(client: TestClient, body: dict[str, Any]) -> None:
    assert client.post("/v1/notes/retrieve", json=body, headers=LOCAL).status_code == 422


def test_supabase_search_is_one_rpc_filtered_on_the_owner() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(
            200,
            json=[
                {
                    "id": str(uuid4()),
                    "page_id": str(uuid4()),
                    "line_index": 2,
                    "similarity": 0.8,
                    "word_rank": None,
                }
            ],
        )

    store = SupabaseNoteLineStore(
        "https://proj.supabase.co",
        api_key="sb_secret_x",
        user_token=None,
        client=httpx.Client(transport=httpx.MockTransport(handler)),
    )
    hits = store.search("user_1", [0.5, 0.5], "gemini-embedding-2", ["enzymes"], None, 40)
    assert hits[0].similarity == 0.8 and hits[0].word_rank is None
    args = json.loads(seen[0].content)
    assert seen[0].url.path == "/rest/v1/rpc/match_note_lines"
    assert (
        args["p_user"] == "user_1"
        and args["p_terms"] == ["enzymes"]
        and args["p_notebooks"] is None
    )
    with pytest.raises(PermissionError):
        store.sync(
            "user_1",
            uuid4(),
            NotePageSync(notebook=BIOLOGY, page_index=0, upsert=[], remove=[]),
            embed_changed_lines([], {}, LexicalEmbedder()),
        )


# ─── The notebook tree (K1): the open chapter first, then its notebook, then the course ─────


def _tree() -> dict[str, NotebookInfo]:
    physics = uuid4()
    forces = uuid4()
    optics = uuid4()
    section = uuid4()
    revision = uuid4()
    return {
        "physics": NotebookInfo(physics, "Physics", COURSE, None, physics),
        "forces": NotebookInfo(forces, "Forces", None, physics, physics),
        "friction": NotebookInfo(section, "Friction", None, forces, physics),
        "optics": NotebookInfo(optics, "Optics", None, physics, physics),
        "revision": NotebookInfo(revision, "Revision", COURSE, None, revision),
        "diary": NotebookInfo(uuid4(), "Diary", None, None, None),
    }


def test_a_chapter_scope_widens_to_its_notebook_then_the_course() -> None:
    t = _tree()
    ladder = ladder_from(list(t.values()), t["forces"].id)
    assert [s.kind for s in ladder] == ["notebook", "notebook", "course"]
    assert set(ladder[0].notebook_ids) == {t["forces"].id, t["friction"].id}
    assert set(ladder[1].notebook_ids) == {
        t["physics"].id,
        t["forces"].id,
        t["friction"].id,
        t["optics"].id,
    }
    # Every notebook linked to the course, with its chapters (only the notebook has the link).
    assert set(ladder[2].notebook_ids) == set(ladder[1].notebook_ids) | {t["revision"].id}
    assert t["diary"].id not in ladder[2].notebook_ids


def test_a_notebook_without_a_course_has_one_rung() -> None:
    t = _tree()
    assert [s.notebook_ids for s in ladder_from(list(t.values()), t["diary"].id)] == [
        [t["diary"].id]
    ]
    assert ladder_from(list(t.values()), uuid4()) == []


def test_hits_in_the_open_chapter_rank_first_then_its_notebook() -> None:
    t = _tree()
    ladder = ladder_from(list(t.values()), t["forces"].id)
    page = {name: uuid4() for name in ("forces", "optics", "revision")}
    hits = [
        (Hit(uuid4(), page["revision"], 0, 0.9, None), 0.026),
        (Hit(uuid4(), page["optics"], 0, 0.8, None), 0.024),
        (Hit(uuid4(), page["forces"], 0, 0.7, None), 0.020),
    ]
    notebook_of = {
        page["forces"]: t["forces"].id,
        page["optics"]: t["optics"].id,
        page["revision"]: t["revision"].id,
    }
    # Scores 0.020 x 1.5 in the chapter, 0.024 x 1.2 in its notebook, 0.026 elsewhere.
    order = [hit.page_id for hit, _ in prefer_near(hits, notebook_of, ladder)]
    assert order == [page["forces"], page["optics"], page["revision"]]
