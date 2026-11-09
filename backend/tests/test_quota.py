from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi.testclient import TestClient

from mew_api.config import Settings
from mew_api.main import create_app

from .conftest import internal_headers

HEADERS = internal_headers()


@pytest.fixture
def client(settings: Settings) -> TestClient:
    return TestClient(create_app(settings, None))


def reserve(client: TestClient, user: str = "local", device: str | None = None) -> int:
    body = {"userId": user, "limit": 8, **({"deviceHash": device} if device else {})}
    status: int = client.post("/v1/quota/reserve", json=body, headers=HEADERS).status_code
    return status


def test_twenty_at_once_get_exactly_eight_through(client: TestClient) -> None:
    with ThreadPoolExecutor(max_workers=20) as pool:
        codes = list(pool.map(lambda _: reserve(client, device="d" * 64), range(20)))
    assert codes.count(200) == 8
    assert codes.count(429) == 12
    refused = client.post(
        "/v1/quota/reserve", json={"userId": "local", "limit": 8}, headers=HEADERS
    )
    assert refused.json()["detail"] == "QUOTA_EXCEEDED"
    left = client.get("/v1/quota/allowance?user=local&limit=8", headers=HEADERS).json()
    assert left == {"used": 8, "limit": 8, "unlimited": False, "remaining": 0}


def test_a_refund_gives_the_question_back_once(client: TestClient) -> None:
    reserved = client.post(
        "/v1/quota/reserve", json={"userId": "local", "limit": 8}, headers=HEADERS
    ).json()
    assert reserved["remaining"] == 7
    question = reserved["questionId"]

    def refund() -> object:
        return client.post(f"/v1/quota/{question}/refund?user=local", headers=HEADERS).json()

    assert refund() == {"changed": True}
    assert refund() == {"changed": False}
    left = client.get("/v1/quota/allowance?user=local&limit=8", headers=HEADERS).json()
    assert left["used"] == 0


def test_only_the_next_server_may_call_it(client: TestClient) -> None:
    body = {"userId": "local", "limit": 8}
    assert client.post("/v1/quota/reserve", json=body).status_code == 401
    bad = {"userId": "../../x", "limit": 8}
    assert client.post("/v1/quota/reserve", json=bad, headers=HEADERS).status_code == 422


def test_a_new_account_starts_with_its_full_allowance(client: TestClient) -> None:
    created = client.post("/v1/quota/ensure", json={"userId": "local", "limit": 8}, headers=HEADERS)
    assert created.status_code == 204
    left = client.get("/v1/quota/allowance?user=local&limit=8", headers=HEADERS).json()
    assert left == {"used": 0, "limit": 8, "unlimited": False, "remaining": 8}


def test_a_deleted_account_is_signed_out_everywhere(client: TestClient) -> None:
    response = client.post("/v1/devices/revoke-user", json={"userId": "user_gone"}, headers=HEADERS)
    assert response.status_code == 204
    assert (
        client.post("/v1/devices/revoke-user", json={"userId": "x;"}, headers=HEADERS).status_code
        == 422
    )


def test_a_learner_who_ran_out_is_flagged_for_an_email(client: TestClient) -> None:
    response = client.post(
        "/v1/quota/notify", json={"userId": "local", "limit": 8}, headers=HEADERS
    )
    assert response.status_code == 204
    store = client.app.state.local_quota  # type: ignore[attr-defined]
    assert "local" in store.notify
