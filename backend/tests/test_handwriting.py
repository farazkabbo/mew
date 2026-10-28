"""K10: the handwriting profile, the student's own samples (their token; counts-only logs)."""

from typing import Any

from fastapi.testclient import TestClient

from mew_api.handwriting.models import SAMPLES_PER_USER

from .conftest import internal_headers
from .test_clips import client  # noqa: F401  (the client fixture)
from .test_devices import LOCAL

PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGP4DwABAQEAG7buVgAAAABJRU5ErkJggg=="


def sample(n: int, **extra: Any) -> dict[str, Any]:
    return {
        "id": f"55555555-5555-4555-8555-{n:012d}",
        "text": "x = 7",
        "latex": "x = 7",
        "readAs": "x = 1",
        "source": "fix",
        "image": PNG,
        **extra,
    }


def test_samples_are_added_listed_and_reset(client: TestClient) -> None:  # noqa: F811
    added = client.post(
        "/v1/handwriting/samples", json={"samples": [sample(1), sample(2)]}, headers=LOCAL
    )
    assert added.status_code == 200, added.text
    assert added.json() == {"saved": 2}
    # The same id again is not a second sample.
    again = client.post("/v1/handwriting/samples", json={"samples": [sample(1)]}, headers=LOCAL)
    assert again.json() == {"saved": 0}

    listed = client.get("/v1/handwriting/samples", headers=LOCAL).json()["samples"]
    assert [s["id"][-1] for s in listed] == ["2", "1"]  # newest first
    assert listed[0]["readAs"] == "x = 1"
    assert isinstance(listed[0]["createdAt"], int)

    reset = client.delete("/v1/handwriting/samples", headers=LOCAL)
    assert reset.json() == {"deleted": 2}
    assert client.get("/v1/handwriting/samples", headers=LOCAL).json() == {"samples": []}


def test_only_the_newest_are_kept(client: TestClient) -> None:  # noqa: F811
    for start in range(0, SAMPLES_PER_USER + 20, 40):
        batch = [sample(n) for n in range(start, start + 40)]
        client.post("/v1/handwriting/samples", json={"samples": batch}, headers=LOCAL)
    listed = client.get("/v1/handwriting/samples", headers=LOCAL).json()["samples"]
    assert len(listed) == SAMPLES_PER_USER


def test_only_real_samples_are_taken(client: TestClient) -> None:  # noqa: F811
    for bad in [
        sample(1, image="PHN2ZyB4bWxucz0i"),  # an SVG, not a PNG
        sample(1, image=PNG + "<"),
        sample(1, text=""),
        sample(1, text="x" * 301),
        sample(1, text="bell\u0007"),
        sample(1, source="training"),
        sample(1, extra="field"),
    ]:
        response = client.post("/v1/handwriting/samples", json={"samples": [bad]}, headers=LOCAL)
        assert response.status_code == 422, bad
    too_many = [sample(n) for n in range(41)]
    response = client.post("/v1/handwriting/samples", json={"samples": too_many}, headers=LOCAL)
    assert response.status_code == 422
    unsigned = client.get("/v1/handwriting/samples", headers=internal_headers())
    assert unsigned.status_code == 401
