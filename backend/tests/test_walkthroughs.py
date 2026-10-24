import json
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient

from mew_api.config import Settings
from mew_api.main import create_app
from mew_api.walkthroughs.models import WalkthroughCreate, WalkthroughUpdate
from mew_api.walkthroughs.store import MemoryWalkthroughStore, SupabaseWalkthroughStore

from .conftest import INTERNAL_SECRET, internal_headers
from .test_clips import recording
from .test_devices import link_device

STEP = {
    "instruction": "Click Insert, at the top.",
    "successCondition": "The Insert tab is selected.",
    "hint": "Pivot tables are made from the Insert tab.",
    "explicit": "Click the Insert tab at the top left.",
    "hints": 0,
    "checks": 0,
    "misses": 0,
    "outcome": None,
}


def new_walkthrough(**changes: Any) -> dict[str, Any]:
    body: dict[str, Any] = {
        "title": "Pivot tables",
        "goal": "teach me how to make a pivot table",
        "app": "excel.exe",
        "steps": [STEP, {**STEP, "instruction": "Click PivotTable."}],
    }
    body.update(changes)
    return body


def progress(revision: int, **changes: Any) -> dict[str, Any]:
    body: dict[str, Any] = {
        "revision": revision,
        "status": "active",
        "phase": "awaiting",
        "current": 1,
        "steps": [
            {**STEP, "hints": 2, "checks": 3, "misses": 2, "outcome": "checked"},
            {**STEP, "instruction": "Click PivotTable."},
        ],
    }
    body.update(changes)
    return body


@pytest.fixture
def client() -> TestClient:
    settings = Settings(
        _env_file=None,
        app_env="development",
        internal_api_secret=INTERNAL_SECRET,
        allowed_hosts=("testserver",),
    )
    return TestClient(create_app(settings, None, warm_checker=False))


def device(token: str) -> dict[str, str]:
    return {**internal_headers(), "X-Mew-Device-Token": token}


# ─── The whole flow, in local mode ──────────────────────────────────────────────────────────


def test_a_device_starts_a_walkthrough_moves_it_on_and_resumes_it(client: TestClient) -> None:
    token = link_device(client)
    created = client.post("/v1/walkthroughs/device", json=new_walkthrough(), headers=device(token))
    assert created.status_code == 201
    walkthrough = created.json()
    assert walkthrough["status"] == "active"
    assert walkthrough["current"] == 0
    assert walkthrough["revision"] == 0
    wid = walkthrough["id"]

    moved = client.put(f"/v1/walkthroughs/device/{wid}", json=progress(0), headers=device(token))
    assert moved.status_code == 200
    assert moved.json()["revision"] == 1
    assert moved.json()["steps"][0]["outcome"] == "checked"

    stopped = client.put(
        f"/v1/walkthroughs/device/{wid}",
        json=progress(1, status="stopped"),
        headers=device(token),
    )
    assert stopped.status_code == 200
    latest = client.get("/v1/walkthroughs/device/latest", headers=device(token))
    assert latest.status_code == 200
    assert latest.json()["id"] == wid
    assert latest.json()["current"] == 1

    got = client.get(f"/v1/walkthroughs/device/{wid}", headers=device(token))
    assert got.json()["status"] == "stopped"


def test_needs_an_active_device_token(client: TestClient) -> None:
    bad = {**internal_headers(), "X-Mew-Device-Token": "mewdt_" + "A" * 43}
    for response in [
        client.post("/v1/walkthroughs/device", json=new_walkthrough(), headers=internal_headers()),
        client.post("/v1/walkthroughs/device", json=new_walkthrough(), headers=bad),
        client.get("/v1/walkthroughs/device/latest", headers=bad),
        client.post(
            "/v1/walkthroughs/device",
            json=new_walkthrough(),
            headers={**internal_headers(), "X-Mew-Device-Token": "not a token"},
        ),
    ]:
        assert response.status_code == 401
    # The internal secret is needed too (only the web app's server calls this API).
    token = link_device(client)
    response = client.post(
        "/v1/walkthroughs/device",
        json=new_walkthrough(),
        headers={"X-Mew-Device-Token": token},
    )
    assert response.status_code in (401, 403)


def test_refuses_another_users_walkthrough(client: TestClient) -> None:
    alice = link_device(client)
    wid = client.post(
        "/v1/walkthroughs/device", json=new_walkthrough(), headers=device(alice)
    ).json()["id"]
    store: MemoryWalkthroughStore = client.app.state.local_walkthroughs  # type: ignore[attr-defined]
    # Another user's walkthrough with the same id isn't visible to them, and vice versa.
    assert store.get("someone_else", uuid.UUID(wid)) is None
    other = store.create("someone_else", WalkthroughCreate.model_validate(new_walkthrough()))
    response = client.get(f"/v1/walkthroughs/device/{other.id}", headers=device(alice))
    assert response.status_code == 404
    response = client.put(
        f"/v1/walkthroughs/device/{other.id}", json=progress(0), headers=device(alice)
    )
    assert response.status_code == 404


def test_two_events_cant_both_apply_to_the_same_state(client: TestClient) -> None:
    token = link_device(client)
    wid = client.post(
        "/v1/walkthroughs/device", json=new_walkthrough(), headers=device(token)
    ).json()["id"]
    first = client.put(f"/v1/walkthroughs/device/{wid}", json=progress(0), headers=device(token))
    second = client.put(f"/v1/walkthroughs/device/{wid}", json=progress(0), headers=device(token))
    assert (first.status_code, second.status_code) == (200, 409)


def test_the_plan_cant_change_and_a_finished_walkthrough_cant_change_at_all(
    client: TestClient,
) -> None:
    token = link_device(client)
    wid = client.post(
        "/v1/walkthroughs/device", json=new_walkthrough(), headers=device(token)
    ).json()["id"]
    rewritten = progress(0)
    rewritten["steps"][1]["instruction"] = "Open PowerShell."
    response = client.put(f"/v1/walkthroughs/device/{wid}", json=rewritten, headers=device(token))
    assert response.status_code == 400
    fewer = progress(0, current=0, steps=progress(0)["steps"][:1])
    response = client.put(f"/v1/walkthroughs/device/{wid}", json=fewer, headers=device(token))
    assert response.status_code == 400

    done = client.put(
        f"/v1/walkthroughs/device/{wid}",
        json=progress(0, status="completed"),
        headers=device(token),
    )
    assert done.status_code == 200
    assert done.json()["completedAt"] is not None
    again = client.put(
        f"/v1/walkthroughs/device/{wid}",
        json=progress(1, status="active"),
        headers=device(token),
    )
    assert again.status_code == 409
    # A finished walkthrough isn't offered to continue.
    assert client.get("/v1/walkthroughs/device/latest", headers=device(token)).status_code == 404


@pytest.mark.parametrize(
    "change",
    [
        {"title": " "},
        {"goal": "x" * 201},
        {"app": "C:\\Users\\me\\excel.exe"},
        {"steps": []},
        {"steps": [STEP] * 16},
        {"steps": [{**STEP, "hint": "line\nbreak"}]},
        {"steps": [{**STEP, "hints": 4}]},
        {"steps": [{**STEP, "outcome": "skipped"}]},
        {"screenshot": "/9j/"},
    ],
)
def test_refuses_malformed_walkthroughs(client: TestClient, change: dict[str, Any]) -> None:
    token = link_device(client)
    response = client.post(
        "/v1/walkthroughs/device", json=new_walkthrough(**change), headers=device(token)
    )
    assert response.status_code == 422


def test_refuses_progress_whose_current_step_doesnt_exist(client: TestClient) -> None:
    token = link_device(client)
    wid = client.post(
        "/v1/walkthroughs/device", json=new_walkthrough(), headers=device(token)
    ).json()["id"]
    response = client.put(
        f"/v1/walkthroughs/device/{wid}", json=progress(0, current=2), headers=device(token)
    )
    assert response.status_code == 422


# ─── The stores ─────────────────────────────────────────────────────────────────────────────


def test_memory_store_offers_only_recent_unfinished_walkthroughs() -> None:
    store = MemoryWalkthroughStore()
    old = store.create("u", WalkthroughCreate.model_validate(new_walkthrough(title="Old")))
    new = store.create("u", WalkthroughCreate.model_validate(new_walkthrough(title="New")))
    now = datetime.now(UTC)
    assert store.latest_resumable("u", now - timedelta(days=7)) == new
    assert store.latest_resumable("u", now + timedelta(seconds=5)) is None
    assert store.latest_resumable("someone_else", now - timedelta(days=7)) is None

    finished = WalkthroughUpdate.model_validate(progress(0, status="completed"))
    assert store.update("u", new.id, finished) is not None
    assert store.latest_resumable("u", now - timedelta(days=7)) == store.get("u", old.id)


def test_supabase_store_filters_on_the_owner_and_writes_compare_and_set() -> None:
    row = {
        "id": str(uuid.uuid4()),
        "title": "Pivot tables",
        "goal": "make a pivot table",
        "app_exe_name": "excel.exe",
        "status": "active",
        "phase": "awaiting",
        "current_step": 1,
        "steps": progress(0)["steps"],
        "revision": 4,
        "started_at": "2026-10-23T10:00:00+00:00",
        "updated_at": "2026-10-23T10:05:00+00:00",
        "completed_at": None,
    }
    http, seen = recording(
        [
            httpx.Response(201, json=[row]),
            httpx.Response(200, json=[row]),
            httpx.Response(200, json=[]),
        ]
    )
    store = SupabaseWalkthroughStore(
        "https://p.supabase.co", api_key="sb_secret_x", user_token=None, client=http
    )
    created = store.create("user_1", WalkthroughCreate.model_validate(new_walkthrough()))
    assert created.current == 1
    insert = json.loads(seen[0].content)[0]
    assert insert["user_id"] == "user_1"
    assert insert["status"] == "active"
    assert insert["steps"][0]["successCondition"] == STEP["successCondition"]

    updated = store.update(
        "user_1", created.id, WalkthroughUpdate.model_validate(progress(4, status="completed"))
    )
    assert updated is not None
    patch = seen[1]
    assert patch.url.params["user_id"] == "eq.user_1"
    assert patch.url.params["revision"] == "eq.4"
    fields = json.loads(patch.content)
    assert fields["revision"] == 5
    assert fields["hints_used"] == 2
    assert fields["completed_at"] is not None

    # Nothing matched (someone else wrote first): no update.
    assert store.update("user_1", created.id, WalkthroughUpdate.model_validate(progress(4))) is None

    store.latest_resumable("user_1", datetime(2026, 10, 16, tzinfo=UTC))
    latest = seen[3]
    assert latest.url.params["user_id"] == "eq.user_1"
    assert latest.url.params["status"] == "in.(active,paused,stopped)"
    assert latest.url.params["order"] == "updated_at.desc"
    assert latest.url.params["updated_at"].startswith("gte.2026-10-16")
