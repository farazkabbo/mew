import json
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient

from mew_api.config import Settings
from mew_api.main import create_app
from mew_api.profiles.store import MemoryProfileStore, SupabaseProfileStore

from .conftest import INTERNAL_SECRET, internal_headers

LOCAL = {**internal_headers(), "X-Mew-Local-User": "local"}


@pytest.fixture
def client() -> TestClient:
    settings = Settings(
        _env_file=None,
        app_env="development",
        internal_api_secret=INTERNAL_SECRET,
        allowed_hosts=("testserver",),
    )
    return TestClient(create_app(settings, None, warm_checker=False))


def test_settings_start_with_defaults_and_merge_changes(client: TestClient) -> None:
    first = client.get("/v1/me/settings", headers=LOCAL)
    assert first.status_code == 200
    assert first.json() == {
        "mew_threshold": 0.7,
        "answer_style": "hints_first",
        "captions": True,
        "auto_check": True,
        "listen_on_open": False,
        "voice_id": None,
        "mew_logging_opt_in": False,
        "onboarded": False,
    }
    changed = client.patch(
        "/v1/me/settings",
        json={"mew_threshold": 0.85, "voice_id": "JBFqnCBsd6RMkjVDRZzb"},
        headers=LOCAL,
    ).json()
    assert changed["mew_threshold"] == 0.85
    assert changed["voice_id"] == "JBFqnCBsd6RMkjVDRZzb"
    # Other keys keep their values; a later change keeps the earlier ones.
    again = client.patch("/v1/me/settings", json={"onboarded": True}, headers=LOCAL).json()
    assert again["mew_threshold"] == 0.85 and again["onboarded"] is True
    # Clearing the voice goes back to the server's default.
    cleared = client.patch("/v1/me/settings", json={"voice_id": None}, headers=LOCAL).json()
    assert cleared["voice_id"] is None


@pytest.mark.parametrize(
    "body",
    [
        {"mew_threshold": 2},
        {"answer_style": "verbose"},
        {"voice_id": "../../v1/admin"},
        {"captions": "yes please"},
        {"is_admin": True},
    ],
    ids=["threshold", "style", "voice-path", "type", "unknown-key"],
)
def test_settings_reject_invalid_changes(client: TestClient, body: dict[str, Any]) -> None:
    assert client.patch("/v1/me/settings", json=body, headers=LOCAL).status_code == 422


def test_settings_need_a_caller(client: TestClient) -> None:
    assert client.get("/v1/me/settings", headers=internal_headers()).status_code == 401
    assert client.get("/v1/me/settings").status_code == 401


def test_memory_store_keeps_users_apart() -> None:
    store = MemoryProfileStore()
    store.update_settings("a", {"captions": False})
    assert store.get_settings("a").captions is False
    assert store.get_settings("b").captions is True


def test_supabase_store_reads_and_merges_the_users_row() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if request.method == "GET":
            return httpx.Response(200, json=[{"settings": {"captions": False, "extra": 1}}])
        if request.method == "PATCH":
            return httpx.Response(200, json=[{}])
        return httpx.Response(201)

    store = SupabaseProfileStore(
        "https://proj.supabase.co",
        api_key="sb_publishable_x",
        user_token="user-jwt",
        client=httpx.Client(transport=httpx.MockTransport(handler)),
    )
    assert store.get_settings("user_1").captions is False
    updated = store.update_settings("user_1", {"onboarded": True})
    assert updated.onboarded is True and updated.captions is False
    _, ensure, read, patch = seen  # (the first is the read above)
    assert ensure.method == "POST" and json.loads(ensure.content) == {"id": "user_1"}
    assert read.url.params["id"] == "eq.user_1"
    # Unknown keys written by other app versions are kept, not dropped.
    assert json.loads(patch.content) == {
        "settings": {"captions": False, "extra": 1, "onboarded": True}
    }
    assert patch.url.params["id"] == "eq.user_1"
    assert all(r.headers["authorization"] == "Bearer user-jwt" for r in seen)
