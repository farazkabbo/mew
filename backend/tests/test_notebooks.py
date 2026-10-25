import json
from typing import Any
from uuid import UUID, uuid4

import httpx
import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from mew_api.config import Settings
from mew_api.main import create_app
from mew_api.notebooks.models import NotebookNode, NotebookTreeSync, parents_first
from mew_api.notebooks.store import MemoryNotebookTreeStore, SupabaseNotebookTreeStore

from .conftest import INTERNAL_SECRET, internal_headers
from .test_clips import recording

LOCAL = {**internal_headers(), "X-Mew-Local-User": "local"}
EDITED = 1_761_386_400_000  # 2025-10-25 10:00 UTC, in epoch milliseconds


def node(title: str, parent: UUID | None = None, **changes: Any) -> dict[str, Any]:
    """A node as the browser sends it (camelCase)."""
    body: dict[str, Any] = {
        "id": str(uuid4()),
        "parentId": str(parent) if parent else None,
        "title": title,
        "position": "a0",
        "childLabel": "Chapters",
        "icon": None,
        "color": None,
        "courseId": None,
        "deletedAt": None,
        "editedAt": EDITED,
    }
    body.update(changes)
    return body


def change(*nodes: dict[str, Any], removed: list[str] | None = None) -> NotebookTreeSync:
    return NotebookTreeSync.model_validate({"nodes": list(nodes), "removed": removed or []})


# ─── The rules, in the memory store (local mode) ─────────────────────────────────────────────


def test_places_three_levels_and_refuses_a_fourth() -> None:
    store = MemoryNotebookTreeStore()
    physics = node("Physics")
    chapter = node("Kinematics", UUID(physics["id"]))
    section = node("Projectiles", UUID(chapter["id"]))
    too_deep = node("Too deep", UUID(section["id"]))
    # Sent children first: the store places parents first anyway.
    results = store.sync("alice", change(too_deep, section, chapter, physics))
    assert [r.status for r in results] == ["rejected", "saved", "saved", "saved"]
    assert {n.title for n in store.tree("alice")} == {"Physics", "Kinematics", "Projectiles"}


def test_refuses_loops_and_moves_that_would_go_too_deep() -> None:
    store = MemoryNotebookTreeStore()
    physics = node("Physics")
    chapter = node("Kinematics", UUID(physics["id"]))
    section = node("Projectiles", UUID(chapter["id"]))
    other = node("Chemistry")
    forces = node("Forces", UUID(other["id"]))
    store.sync("alice", change(physics, chapter, section, other, forces))

    loop = {**physics, "parentId": section["id"], "editedAt": EDITED + 1}
    deep = {**chapter, "parentId": forces["id"], "editedAt": EDITED + 1}
    fine = {**chapter, "parentId": other["id"], "editedAt": EDITED + 2}
    assert store.sync("alice", change(loop))[0].status == "rejected"
    assert store.sync("alice", change(deep))[0].status == "rejected"
    moved = store.sync("alice", change(fine))[0]
    assert moved.status == "saved"
    assert moved.node is not None and moved.node.parent_id == UUID(other["id"])


def test_numbers_clashing_names_ignoring_case_and_the_trash() -> None:
    store = MemoryNotebookTreeStore()
    store.sync("alice", change(node("Physics")))
    clash, trashed = store.sync("alice", change(node("PHYSICS"), node("physics", deletedAt=EDITED)))
    assert clash.status == "renamed" and clash.node and clash.node.title == "PHYSICS 2"
    assert trashed.status == "saved" and trashed.node and trashed.node.title == "physics"


def test_keeps_the_latest_edit() -> None:
    store = MemoryNotebookTreeStore()
    physics = node("Physics")
    store.sync("alice", change({**physics, "title": "Physics (laptop)", "editedAt": EDITED + 5}))
    [stale] = store.sync("alice", change({**physics, "title": "Physics (tablet)"}))
    assert stale.status == "stale"
    assert stale.node and stale.node.title == "Physics (laptop)"


def test_purges_a_node_with_everything_under_it() -> None:
    store = MemoryNotebookTreeStore()
    physics = node("Physics")
    store.sync("alice", change(physics, node("Kinematics", UUID(physics["id"]))))
    store.sync("alice", change(removed=[physics["id"]]))
    assert store.tree("alice") == []


def test_users_never_touch_each_others_nodes() -> None:
    store = MemoryNotebookTreeStore()
    physics = node("Physics")
    store.sync("alice", change(physics))
    [taken] = store.sync("bob", change({**physics, "title": "Mine", "editedAt": EDITED + 9}))
    assert taken.status == "rejected" and taken.node is None
    [under] = store.sync("bob", change(node("Inside", UUID(physics["id"]))))
    assert under.status == "rejected"
    store.sync("bob", change(removed=[physics["id"]]))
    assert [n.title for n in store.tree("alice")] == ["Physics"]
    assert store.tree("bob") == []


def test_validates_what_the_browser_sends() -> None:
    physics = node("Physics")
    with pytest.raises(ValidationError):
        change(physics, physics)  # the same node twice
    with pytest.raises(ValidationError):
        change(physics, removed=[physics["id"]])
    for bad in (
        {"title": "   "},
        {"title": "Physics\u0000"},
        {"position": "a 0"},
        {"childLabel": "Folders"},
        {"icon": "skull"},
        {"editedAt": -1},
    ):
        with pytest.raises(ValidationError):
            change({**node("Physics"), **bad})


def test_orders_parents_first_even_when_sent_backwards() -> None:
    a = NotebookNode.model_validate(node("A"))
    b = NotebookNode.model_validate(node("B", a.id))
    c = NotebookNode.model_validate(node("C", b.id))
    assert [n.title for n in parents_first([c, b, a])] == ["A", "B", "C"]


# ─── The routes (local mode) ─────────────────────────────────────────────────────────────────


@pytest.fixture
def dev_client() -> TestClient:
    settings = Settings(
        _env_file=None,
        app_env="development",
        internal_api_secret=INTERNAL_SECRET,
        allowed_hosts=("testserver",),
    )
    return TestClient(create_app(settings, None, warm_checker=False))


def test_syncs_and_reads_back_the_tree(dev_client: TestClient) -> None:
    physics = node("Physics", icon="atom", color="teal")
    chapter = node("Forces", UUID(physics["id"]), position="a1")
    synced = dev_client.put(
        "/v1/notebooks/tree", json={"nodes": [physics, chapter], "removed": []}, headers=LOCAL
    )
    assert synced.status_code == 200
    assert [r["status"] for r in synced.json()["results"]] == ["saved", "saved"]
    assert synced.json()["results"][1]["node"]["parentId"] == physics["id"]

    tree = dev_client.get("/v1/notebooks/tree", headers=LOCAL).json()["nodes"]
    assert sorted(n["title"] for n in tree) == ["Forces", "Physics"]
    assert next(n for n in tree if n["title"] == "Physics")["icon"] == "atom"


def test_refuses_oversized_syncs_and_strangers(dev_client: TestClient) -> None:
    many = [node(f"N{i}") for i in range(201)]
    too_big = dev_client.put(
        "/v1/notebooks/tree", json={"nodes": many, "removed": []}, headers=LOCAL
    )
    assert too_big.status_code == 422
    assert dev_client.get("/v1/notebooks/tree", headers=internal_headers()).status_code == 401


# ─── Supabase ────────────────────────────────────────────────────────────────────────────────


def test_supabase_store_sends_snake_case_and_reads_the_results_back() -> None:
    physics = node("Physics")
    chapter = node("Forces", UUID(physics["id"]), deletedAt=EDITED)
    server_row = {
        "id": chapter["id"],
        "parent_id": physics["id"],
        "title": "Forces 2",
        "position": "a0",
        "child_label": "Chapters",
        "icon": None,
        "color": None,
        "course_id": None,
        "deleted_at": "2025-10-25T10:00:00+00:00",
        "edited_at": "2025-10-25T10:00:00.250+00:00",
    }
    http, seen = recording(
        [
            httpx.Response(
                200,
                json=[
                    {"id": chapter["id"], "status": "renamed", "node": server_row},
                    {"id": physics["id"], "status": "rejected", "node": None},
                ],
            )
        ]
    )
    store = SupabaseNotebookTreeStore(
        "https://db.example", api_key="publishable", user_token="token", client=http
    )
    results = store.sync("alice", change(chapter, physics))

    assert seen[0].url.path == "/rest/v1/rpc/sync_notebook_tree"
    sent = json.loads(seen[0].content)
    assert [n["title"] for n in sent["p_nodes"]] == ["Physics", "Forces"]  # parents first
    assert sent["p_nodes"][1]["parent_id"] == physics["id"]
    assert sent["p_nodes"][1]["deleted_at"] == "2025-10-25T10:00:00+00:00"
    # One result per node, in the order sent, with times back in milliseconds.
    assert [r.status for r in results] == ["renamed", "rejected"]
    renamed = results[0].node
    assert renamed is not None
    assert renamed.title == "Forces 2"
    assert renamed.edited_at == EDITED + 250


def test_supabase_store_never_writes_with_the_secret_key() -> None:
    http, seen = recording([])
    store = SupabaseNotebookTreeStore(
        "https://db.example", api_key="secret", user_token=None, client=http
    )
    with pytest.raises(PermissionError):
        store.sync("alice", change(node("Physics")))
    assert seen == []


def test_supabase_store_skips_rows_that_dont_fit() -> None:
    good = {
        "id": str(uuid4()),
        "parent_id": None,
        "title": "Physics",
        "position": "a0",
        "child_label": "Chapters",
        "icon": None,
        "color": None,
        "course_id": None,
        "deleted_at": None,
        "edited_at": "2025-10-25T10:00:00+00:00",
    }
    odd = {**good, "id": str(uuid4()), "title": "Bad\u0007title"}
    http, _ = recording([httpx.Response(200, json=[good, odd])])
    store = SupabaseNotebookTreeStore(
        "https://db.example", api_key="publishable", user_token="token", client=http
    )
    assert [n.title for n in store.tree("alice")] == ["Physics"]
