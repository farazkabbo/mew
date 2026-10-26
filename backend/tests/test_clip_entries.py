"""Circle & Ask entries (S3.2): clips that carry an explanation, appended to by follow-ups."""

import json
import uuid
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient

from mew_api.clips.models import ClipCreate, EntryAppend
from mew_api.clips.store import EntryFullError, MemoryClipStore, SupabaseClipWriter

from .conftest import internal_headers
from .test_clips import client, clip_body, recording, save  # noqa: F401  (the client fixture)
from .test_devices import link_device

SESSION = "11111111-1111-4111-8111-111111111111"
STROKE = {"tool": "pen", "color": "#8a7bf0", "width": 3, "points": [[1, 2, 0.5, 0], [3, 4, 0.5, 8]]}
MARK = {"tool": "pen", "color": "#3b5b8c", "width": 3, "points": [[5, 5, 0.5, 0]]}
TURN = {
    "question": "Explain this",
    "steps": ["This axis is velocity.", "So a flat part means constant speed."],
    "summary": "A flat line on a velocity-time graph means constant speed.",
    "followUpQuestion": "What's the acceleration there?",
}


def entry_body(**changes: Any) -> dict[str, Any]:
    body = clip_body(strokes=[STROKE, STROKE])
    body["entry"] = {
        "sessionId": SESSION,
        "studentStrokes": [MARK],
        "turn": TURN,
        "strokeSteps": [0, 1],
        "conceptHints": ["Acceleration"],
    }
    body["entry"].update(changes)
    return body


def append_body(**changes: Any) -> dict[str, Any]:
    body: dict[str, Any] = {
        "sessionId": SESSION,
        "turn": {"question": "And this?", "steps": ["That's the steep part."], "summary": "Steep."},
        "strokes": [STROKE],
        "strokeSteps": [0],
        "conceptHints": ["Velocity"],
    }
    body.update(changes)
    return body


def device(token: str) -> dict[str, str]:
    return {**internal_headers(), "X-Mew-Device-Token": token}


def test_an_entry_is_saved_and_read_back_with_its_explanation(client: TestClient) -> None:  # noqa: F811
    token = link_device(client)
    created = save(client, token, entry_body())
    assert created.status_code == 201
    clip_id = created.json()["clipId"]

    view = client.get(
        f"/v1/clips/{clip_id}", headers={**internal_headers(), "X-Mew-Local-User": "local"}
    )
    assert view.status_code == 200
    entry = view.json()["entry"]
    assert entry["sessionId"] == SESSION
    assert entry["turns"] == [TURN]
    assert entry["strokeSteps"] == [[0, 0], [0, 1]]
    assert entry["studentStrokes"][0]["color"] == "#3b5b8c"
    assert entry["conceptHints"] == ["Acceleration"]


def test_an_ordinary_clip_has_no_entry(client: TestClient) -> None:  # noqa: F811
    token = link_device(client)
    clip_id = save(client, token).json()["clipId"]
    view = client.get(
        f"/v1/clips/{clip_id}", headers={**internal_headers(), "X-Mew-Local-User": "local"}
    )
    assert view.json().get("entry") is None  # left out: the web app reads it as null


def test_a_follow_up_is_added_to_the_same_entry(client: TestClient) -> None:  # noqa: F811
    token = link_device(client)
    clip_id = save(client, token, entry_body()).json()["clipId"]
    added = client.post("/v1/clips/entries/append", json=append_body(), headers=device(token))
    assert added.status_code == 200
    assert added.json()["clipId"] == clip_id

    entry = client.get(
        f"/v1/clips/{clip_id}", headers={**internal_headers(), "X-Mew-Local-User": "local"}
    ).json()
    assert [t["question"] for t in entry["entry"]["turns"]] == ["Explain this", "And this?"]
    assert entry["entry"]["strokeSteps"] == [[0, 0], [0, 1], [1, 0]]
    assert len(entry["strokes"]) == 3
    assert entry["entry"]["conceptHints"] == ["Acceleration", "Velocity"]


def test_a_follow_up_needs_its_entry_and_a_device(client: TestClient) -> None:  # noqa: F811
    token = link_device(client)
    missing = client.post("/v1/clips/entries/append", json=append_body(), headers=device(token))
    assert missing.status_code == 404
    unsigned = client.post(
        "/v1/clips/entries/append", json=append_body(), headers=internal_headers()
    )
    assert unsigned.status_code == 401


@pytest.mark.parametrize(
    "change",
    [
        {"strokeSteps": [0]},  # a step for every stroke
        {"strokeSteps": [0, 5]},  # only the turn's steps
        {"turn": {**TURN, "steps": []}},
        {"turn": {**TURN, "steps": ["x"] * 6}},
        {"turn": {**TURN, "summary": "line\u0007"}},
        {"studentStrokes": [MARK] * 13},
        {"sessionId": "not-a-uuid"},
    ],
)
def test_refuses_malformed_entries(client: TestClient, change: dict[str, Any]) -> None:  # noqa: F811
    token = link_device(client)
    assert save(client, token, entry_body(**change)).status_code == 422


def test_refuses_a_follow_up_whose_strokes_and_steps_dont_match(client: TestClient) -> None:  # noqa: F811
    token = link_device(client)
    save(client, token, entry_body())
    response = client.post(
        "/v1/clips/entries/append", json=append_body(strokeSteps=[]), headers=device(token)
    )
    assert response.status_code == 422


def test_an_entry_fills_up() -> None:
    store = MemoryClipStore()
    store.create("u", uuid.uuid4(), ClipCreate.model_validate(entry_body()), b"jpeg")
    follow_up = EntryAppend.model_validate(append_body())
    for _ in range(11):
        assert store.append("u", follow_up) is not None
    with pytest.raises(EntryFullError):
        store.append("u", follow_up)
    # Someone else's session is never found.
    assert store.append("v", follow_up) is None


def test_supabase_appends_compare_and_set_on_the_revision() -> None:
    clip_id = str(uuid.uuid4())
    row = {
        "id": clip_id,
        "annotations": [STROKE],
        "student_strokes": [MARK],
        "entry": {"turns": [TURN], "strokeSteps": [[0, 0]], "conceptHints": []},
        "revision": 2,
    }
    http, seen = recording([httpx.Response(200, json=[row]), httpx.Response(200, json=[row])])
    writer = SupabaseClipWriter(
        "https://p.supabase.co", api_key="sb_secret_x", user_token=None, client=http
    )
    assert writer.append("user_1", EntryAppend.model_validate(append_body())) == uuid.UUID(clip_id)

    lookup, patch = seen
    assert lookup.url.params["user_id"] == "eq.user_1"
    assert lookup.url.params["session_id"] == f"eq.{SESSION}"
    assert patch.url.params["revision"] == "eq.2"
    fields = json.loads(patch.content)
    assert fields["revision"] == 3
    assert fields["entry"]["strokeSteps"] == [[0, 0], [1, 0]]
    assert len(fields["annotations"]) == 2
