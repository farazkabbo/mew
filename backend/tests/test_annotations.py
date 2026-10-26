"""K9: the device's live annotations reach the server (its own token; counts-only logs)."""

from typing import Any

from fastapi.testclient import TestClient

from .conftest import internal_headers
from .test_clips import client  # noqa: F401  (the client fixture)
from .test_devices import LOCAL

MARK: dict[str, Any] = {
    "id": "44444444-4444-4444-8444-000000000001",
    "pageId": "11111111-1111-4111-8111-111111111111",
    "lineId": "22222222-2222-4222-8222-222222222222",
    "markKind": "error",
    "verdict": "incorrect",
    "checkerMethod": "math",
    "recognizedText": "3x = 26",
    "confidence": 0.92,
    "strokeGroupId": "33333333-3333-4333-8333-333333333333",
    "note": "sign?",
    "createdAt": 1_790_000_000_000,
    "resolvedAt": None,
    "dismissedAs": None,
    "evidence": None,
}


def test_marks_are_upserted_by_id_and_keep_their_line(client: TestClient) -> None:  # noqa: F811
    first = client.put("/v1/annotations", json={"annotations": [MARK]}, headers=LOCAL)
    assert first.status_code == 200, first.text
    assert first.json() == {"saved": 1}
    # Dismissed as "not wrong": the same mark again, with how it ended.
    later = {**MARK, "dismissedAs": "not_wrong", "resolvedAt": 1_790_000_060_000}
    assert client.put("/v1/annotations", json={"annotations": [later]}, headers=LOCAL).json() == {
        "saved": 1
    }
    rows = client.app.state.local_annotations.rows("local")  # type: ignore[attr-defined]
    assert [(r["dismissed_as"], r["note"]) for r in rows] == [("not_wrong", "sign?")]
    # Moving a mark to another line is refused (not saved).
    moved = {**MARK, "lineId": "22222222-2222-4222-8222-000000000009"}
    assert client.put("/v1/annotations", json={"annotations": [moved]}, headers=LOCAL).json() == {
        "saved": 0
    }


def test_only_marks_are_taken(client: TestClient) -> None:  # noqa: F811
    for bad in [
        {**MARK, "markKind": "smiley"},
        {**MARK, "note": "x" * 33},
        {**MARK, "confidence": 2},
        {**MARK, "strokes": []},
        {**MARK, "recognizedText": "bad\u0007"},
    ]:
        response = client.put("/v1/annotations", json={"annotations": [bad]}, headers=LOCAL)
        assert response.status_code == 422, bad
    too_many = client.put("/v1/annotations", json={"annotations": [MARK] * 51}, headers=LOCAL)
    assert too_many.status_code == 422
    unsigned = client.put(
        "/v1/annotations", json={"annotations": [MARK]}, headers=internal_headers()
    )
    assert unsigned.status_code == 401
