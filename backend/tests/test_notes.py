import json
from collections.abc import Sequence
from typing import Any
from uuid import UUID, uuid4

import httpx
import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from mew_api.config import Settings
from mew_api.courses.embeddings import LEXICAL_MODEL
from mew_api.main import create_app
from mew_api.notes.embedding import StoredLine, embed_changed_lines
from mew_api.notes.models import NoteLineUpsert, NotePageSync
from mew_api.notes.store import MemoryNoteLineStore, SupabaseNoteLineStore

from .conftest import INTERNAL_SECRET, internal_headers

LOCAL = {**internal_headers(), "X-Mew-Local-User": "local"}
NOTEBOOK = "11111111-1111-4111-8111-111111111111"
PAGE = "22222222-2222-4222-8222-222222222222"
OTHER_PAGE = "33333333-3333-4333-8333-333333333333"
CLIP = "44444444-4444-4444-8444-444444444444"


@pytest.fixture
def client() -> TestClient:
    settings = Settings(
        _env_file=None,
        app_env="development",
        internal_api_secret=INTERNAL_SECRET,
        allowed_hosts=("testserver",),
    )
    return TestClient(create_app(settings, None, warm_checker=False))


def line(text: str, *, line_id: str | None = None, index: int = 0, **extra: Any) -> dict[str, Any]:
    return {
        "id": line_id or str(uuid4()),
        "lineIndex": index,
        "bbox": [10, 20 + 30 * index, 200, 24],
        "source": "ink",
        "text": text,
        "latex": None,
        "confidence": 0.9,
        "contentHash": "0a1b2c3d",
        **extra,
    }


def body(upsert: list[dict[str, Any]], remove: Sequence[str] = ()) -> dict[str, Any]:
    return {
        "notebook": {"id": NOTEBOOK, "title": "Biology", "courseId": None},
        "pageIndex": 0,
        "upsert": upsert,
        "remove": list(remove),
    }


def put(client: TestClient, payload: dict[str, Any], page: str = PAGE) -> httpx.Response:
    response: httpx.Response = client.put(
        f"/v1/notes/pages/{page}/lines", json=payload, headers=LOCAL
    )
    return response


def local_lines(client: TestClient) -> dict[str, tuple[str, str | None]]:
    """The local user's lines: id -> (text, embedding model)."""
    app: Any = client.app
    store: MemoryNoteLineStore = app.state.local_notes
    return {str(s.line.id): (s.line.text, s.embedding_model) for s in store.lines_of("local")}


# ─── The route ───────────────────────────────────────────────────────────────────────────────


def test_a_page_sync_stores_lines_and_embeds_only_changed_text(client: TestClient) -> None:
    first, second = line("enzymes lower activation energy"), line("not used up", index=1)
    created = put(client, body([first, second]))
    assert created.status_code == 200
    assert created.json() == {"embedded": 2}
    assert local_lines(client) == {
        first["id"]: ("enzymes lower activation energy", LEXICAL_MODEL),
        second["id"]: ("not used up", LEXICAL_MODEL),
    }

    # Renumbering (same text) costs nothing; a changed line is embedded again.
    moved = put(client, body([{**first, "lineIndex": 2}, {**second, "text": "not consumed"}]))
    assert moved.json() == {"embedded": 1}
    assert local_lines(client)[second["id"]] == ("not consumed", LEXICAL_MODEL)

    removed = put(client, body([], remove=[first["id"]]))
    assert removed.status_code == 200
    assert list(local_lines(client)) == [second["id"]]


def test_a_line_of_another_page_is_never_moved(client: TestClient) -> None:
    mine = line("on the first page")
    put(client, body([mine]))
    put(client, body([{**mine, "text": "hijacked"}]), page=OTHER_PAGE)
    put(client, body([], remove=[mine["id"]]), page=OTHER_PAGE)
    assert local_lines(client)[mine["id"]][0] == "on the first page"


@pytest.mark.parametrize(
    "payload",
    [
        body([line("")]),
        body([line("x" * 301)]),
        body([line("bell\x07")]),
        body([line("slide text", source="clip")]),
        body([line("ink", clipId=CLIP)]),
        body([line("bad hash", contentHash="nothex!!")]),
        body([line("negative box", bbox=[0, 0, -5, 10])]),
        body([line("twice", line_id=PAGE), line("twice", line_id=PAGE)]),
        body([line("and removed", line_id=PAGE)], remove=[PAGE]),
        body([line("x") for _ in range(201)]),
        body([], remove=[str(uuid4()) for _ in range(1001)]),
        {**body([]), "pageIndex": -1},
        {**body([]), "notebook": {"id": NOTEBOOK, "title": "", "courseId": None}},
        {**body([]), "extra": True},
    ],
    ids=[
        "empty",
        "too-long",
        "control-char",
        "clip-without-clip",
        "ink-with-clip",
        "hash",
        "box",
        "duplicate",
        "upserted-and-removed",
        "too-many-lines",
        "too-many-removals",
        "page-index",
        "untitled",
        "unknown-key",
    ],
)
def test_a_sync_refuses_invalid_input(client: TestClient, payload: dict[str, Any]) -> None:
    assert put(client, payload).status_code == 422
    assert local_lines(client) == {}


def test_clip_lines_are_accepted_with_their_clip(client: TestClient) -> None:
    slide = line("Enzymes are not consumed", source="clip", clipId=CLIP)
    assert put(client, body([slide])).status_code == 200


def test_a_sync_needs_the_internal_secret_and_a_caller(client: TestClient) -> None:
    path = f"/v1/notes/pages/{PAGE}/lines"
    assert client.put(path, json=body([])).status_code == 401
    assert client.put(path, json=body([]), headers=internal_headers()).status_code == 401


def test_turning_the_setting_off_deletes_the_copy(client: TestClient) -> None:
    put(client, body([line("a note")]))
    assert local_lines(client) != {}
    response = client.patch("/v1/me/settings", json={"notes_index": False}, headers=LOCAL)
    assert response.status_code == 200
    assert response.json()["notes_index"] is False
    assert local_lines(client) == {}


# ─── Which lines are embedded ────────────────────────────────────────────────────────────────


class CountingEmbedder:
    model = "test-embedder"

    def __init__(self, *, fail: bool = False) -> None:
        self.fail = fail
        self.calls: list[list[str]] = []

    def embed_documents(self, texts: Sequence[tuple[str | None, str]]) -> list[list[float]]:
        self.calls.append([text for _, text in texts])
        if self.fail:
            raise RuntimeError("quota")
        return [[float(len(text))] for _, text in texts]

    def embed_query(self, text: str) -> list[float]:
        return [float(len(text))]


def upsert(text: str, line_id: UUID | None = None) -> NoteLineUpsert:
    return NoteLineUpsert.model_validate(line(text, line_id=str(line_id or uuid4())))


def test_unchanged_text_from_the_same_embedder_is_kept() -> None:
    same, changed, other_model, unembedded, new = (uuid4() for _ in range(5))
    stored = {
        same: StoredLine("same", "test-embedder"),
        changed: StoredLine("before", "test-embedder"),
        other_model: StoredLine("other", "lexical-hash-v1"),
        unembedded: StoredLine("plain", None),
    }
    lines = [
        upsert("same", same),
        upsert("after", changed),
        upsert("other", other_model),
        upsert("plain", unembedded),
        upsert("new", new),
    ]
    embedder = CountingEmbedder()
    result = embed_changed_lines(lines, stored, embedder)
    assert result.kept == {same}
    assert embedder.calls == [["after", "other", "plain", "new"]]  # one batch
    assert set(result.vectors) == {changed, other_model, unembedded, new}


def test_a_failed_embedding_still_saves_the_text() -> None:
    embedder = CountingEmbedder(fail=True)
    result = embed_changed_lines([upsert("a note")], {}, embedder)
    assert result.vectors == {} and result.kept == frozenset()


def test_nothing_to_embed_makes_no_call() -> None:
    line_id = uuid4()
    embedder = CountingEmbedder()
    stored = {line_id: StoredLine("same", embedder.model)}
    embed_changed_lines([upsert("same", line_id)], stored, embedder)
    assert embedder.calls == []


# ─── Supabase ────────────────────────────────────────────────────────────────────────────────


def test_supabase_store_syncs_a_page_in_one_call_as_the_student() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if request.method == "GET":
            return httpx.Response(200, json=[{"id": PAGE, "text": "old", "embedding_model": None}])
        return httpx.Response(204)

    store = SupabaseNoteLineStore(
        "https://proj.supabase.co",
        api_key="sb_publishable_x",
        user_token="user-jwt",
        client=httpx.Client(transport=httpx.MockTransport(handler)),
    )
    assert store.stored_lines("user_1", UUID(PAGE)) == {UUID(PAGE): StoredLine("old", None)}

    kept, embedded = uuid4(), uuid4()
    sync = NotePageSync.model_validate(
        body([line("kept", line_id=str(kept)), line("new", line_id=str(embedded))], [str(uuid4())])
    )
    embedder = CountingEmbedder()
    result = embed_changed_lines(sync.upsert, {kept: StoredLine("kept", embedder.model)}, embedder)
    store.sync("user_1", UUID(PAGE), sync, result)
    store.delete_all("user_1")

    read, rpc, delete = seen
    assert read.url.params["page_id"] == f"eq.{PAGE}"
    assert read.url.params["user_id"] == "eq.user_1"
    assert rpc.url.path == "/rest/v1/rpc/sync_note_page"
    args = json.loads(rpc.content)
    assert args["p_page"] == PAGE and args["p_index"] == 0
    assert args["p_notebook"] == {"id": NOTEBOOK, "title": "Biology", "course_id": None}
    by_id = {a["id"]: a for a in args["p_lines"]}
    assert by_id[str(kept)]["keep_embedding"] is True
    assert by_id[str(kept)]["embedding"] is None
    assert by_id[str(embedded)]["embedding"] == "[3.000000]"
    assert by_id[str(embedded)]["embedding_model"] == "test-embedder"
    assert len(args["p_removed"]) == 1
    assert delete.method == "DELETE" and delete.url.params["user_id"] == "eq.user_1"
    assert all(r.headers["authorization"] == "Bearer user-jwt" for r in seen)


def test_a_database_refusal_reaches_the_route_as_permission_error() -> None:
    """RLS refusing lines (e.g. the setting is off) must not look like a storage outage."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(403, json={"message": "new row violates row-level security"})

    store = SupabaseNoteLineStore(
        "https://proj.supabase.co",
        api_key="sb_publishable_x",
        user_token="user-jwt",
        client=httpx.Client(transport=httpx.MockTransport(handler)),
    )
    with pytest.raises(PermissionError):
        store.stored_lines("user_1", UUID(PAGE))


def test_refuses_blank_titles_and_lines_after_trimming() -> None:
    def sync(title: str) -> dict[str, object]:
        notebook = {"id": NOTEBOOK, "title": title, "courseId": None}
        return {"notebook": notebook, "pageIndex": 0, "upsert": [], "remove": []}

    assert NotePageSync.model_validate(sync(" Physics ")).notebook.title == "Physics"
    with pytest.raises(ValidationError):
        NotePageSync.model_validate(sync("   "))
