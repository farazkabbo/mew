import json
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient

from mew_api.config import Settings
from mew_api.main import create_app
from mew_api.mew_events.store import SupabaseMewEventStore

from .conftest import INTERNAL_SECRET, internal_headers

LOCAL = {**internal_headers(), "X-Mew-Local-User": "local"}

GATE_INPUT = {
    "trigger": "utterance",
    "lastUtterance": "why does the force cancel out?",
    "recentTranscript": ["okay so"],
    "notebookSignals": {"msSinceLastStroke": 1500, "justErased": False, "linesWrittenLast60s": 1},
    "tutorSpokeRecently": False,
    "explicitSummon": False,
}
EVENT = {
    "input": GATE_INPUT,
    "output": {"label": "answer_question", "confidence": 0.93, "reason": "direct question"},
    "source": "model",
    "latencyMs": 640,
}


@pytest.fixture
def client() -> TestClient:
    settings = Settings(
        _env_file=None,
        app_env="development",
        internal_api_secret=INTERNAL_SECRET,
        allowed_hosts=("testserver",),
    )
    return TestClient(create_app(settings, None, warm_checker=False))


def opt_in(client: TestClient, value: bool = True) -> None:
    response = client.patch("/v1/me/settings", json={"mew_logging_opt_in": value}, headers=LOCAL)
    assert response.status_code == 200


def test_nothing_is_kept_without_opt_in(client: TestClient) -> None:
    response = client.post("/v1/mew/events", json=EVENT, headers=LOCAL)
    assert response.json() == {"logged": False}
    assert client.get("/v1/mew/events", headers=LOCAL).json() == {"events": []}


def test_kept_decisions_can_be_labelled_exported_and_deleted(client: TestClient) -> None:
    opt_in(client)
    for _ in range(3):
        assert client.post("/v1/mew/events", json=EVENT, headers=LOCAL).json() == {"logged": True}

    events = client.get("/v1/mew/events", headers=LOCAL).json()["events"]
    assert len(events) == 3
    first = events[0]
    assert first["input"]["lastUtterance"] == "why does the force cancel out?"
    assert first["output"] == {
        "label": "answer_question",
        "confidence": 0.93,
        "reason": "direct question",
        "source": "model",
        "latencyMs": 640,
    }
    assert first["human_label"] is None

    labelled = client.patch(
        f"/v1/mew/events/{first['id']}", json={"human_label": "give_hint"}, headers=LOCAL
    )
    assert labelled.status_code == 204
    unlabeled = client.get("/v1/mew/events", params={"unlabeled": True}, headers=LOCAL).json()
    assert len(unlabeled["events"]) == 2
    exported = client.get("/v1/mew/events/labeled", headers=LOCAL).json()["events"]
    assert [e["human_label"] for e in exported] == ["give_hint"]

    # Opting out stops new logging; deleting forgets everything.
    opt_in(client, False)
    assert client.post("/v1/mew/events", json=EVENT, headers=LOCAL).json() == {"logged": False}
    assert client.delete("/v1/mew/events", headers=LOCAL).status_code == 204
    assert client.get("/v1/mew/events", headers=LOCAL).json() == {"events": []}


@pytest.mark.parametrize(
    "change",
    [
        {"output": {**EVENT["output"], "label": "explode"}},  # type: ignore[dict-item]
        {"input": {**GATE_INPUT, "lastUtterance": "x" * 501}},
        {"input": {**GATE_INPUT, "recentTranscript": ["x"] * 7}},
        {"input": {**GATE_INPUT, "extra": "field"}},
        {"source": "made-up"},
    ],
    ids=["label", "long-utterance", "long-transcript", "extra-field", "source"],
)
def test_refuses_malformed_events(client: TestClient, change: dict[str, Any]) -> None:
    opt_in(client)
    assert client.post("/v1/mew/events", json={**EVENT, **change}, headers=LOCAL).status_code == 422


def test_labels_are_checked_and_unknown_events_are_not_found(client: TestClient) -> None:
    opt_in(client)
    client.post("/v1/mew/events", json=EVENT, headers=LOCAL)
    event = client.get("/v1/mew/events", headers=LOCAL).json()["events"][0]
    bad = client.patch(f"/v1/mew/events/{event['id']}", json={"human_label": "x"}, headers=LOCAL)
    assert bad.status_code == 422
    unknown = "00000000-0000-4000-8000-000000000000"
    gone = client.patch(f"/v1/mew/events/{unknown}", json={"human_label": None}, headers=LOCAL)
    assert gone.status_code == 404
    assert client.get("/v1/mew/events", headers=internal_headers()).status_code == 401


def test_supabase_store_scopes_every_request_to_the_user() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if request.method == "POST":
            return httpx.Response(403, json={"code": "42501"})  # RLS: no opt-in
        return httpx.Response(200, json=[])

    store = SupabaseMewEventStore(
        "https://proj.supabase.co",
        api_key="sb_publishable_x",
        user_token="user-jwt",
        client=httpx.Client(transport=httpx.MockTransport(handler)),
    )
    assert store.add_event("user_1", GATE_INPUT, {}) is False
    assert json.loads(seen[0].content) == [{"input": GATE_INPUT, "output": {}}]  # no user_id
    store.list_events("user_1", unlabeled_only=True, before=None, limit=5)
    assert seen[1].url.params["user_id"] == "eq.user_1"
    assert seen[1].url.params["human_label"] == "is.null"
    assert store.label_event("user_1", __import__("uuid").uuid4(), "ignore") is False
    store.delete_events("user_1")
    assert seen[-1].method == "DELETE" and seen[-1].url.params["user_id"] == "eq.user_1"
