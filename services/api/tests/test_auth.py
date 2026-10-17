import time

import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient
from jwt import PyJWKSet

from mew_api.auth import AuthUnavailableError, InvalidTokenError, JwksCache
from mew_api.config import Settings
from mew_api.main import create_app

from .conftest import INTERNAL_SECRET, TokenFactory, internal_headers


def test_valid_token_returns_the_verified_user(
    client: TestClient, make_token: TokenFactory
) -> None:
    response = client.get("/v1/me", headers=internal_headers(make_token()))

    assert response.status_code == 200
    assert response.json() == {"user_id": "user_123"}


@pytest.mark.parametrize(
    "headers",
    [
        {},
        {"X-Internal-Secret": "wrong" * 10},
        {"X-Internal-Secret": INTERNAL_SECRET[:-1]},
    ],
    ids=["missing", "wrong", "prefix"],
)
def test_internal_secret_is_required(
    client: TestClient, make_token: TokenFactory, headers: dict[str, str]
) -> None:
    headers = {**headers, "Authorization": f"Bearer {make_token()}"}

    assert client.get("/v1/me", headers=headers).status_code == 401


def test_missing_token_is_rejected(client: TestClient) -> None:
    response = client.get("/v1/me", headers=internal_headers())

    assert response.status_code == 401
    assert response.headers["www-authenticate"] == "Bearer"


@pytest.mark.parametrize(
    "claims",
    [
        {"exp": int(time.time()) - 120},
        {"nbf": int(time.time()) + 120},
        {"iss": "https://attacker.clerk.accounts.dev"},
        {"azp": "https://evil.example"},
        {"sub": None},
        {"exp": None},
        {"sts": "pending"},
    ],
    ids=["expired", "not-yet-valid", "wrong-issuer", "wrong-azp", "no-sub", "no-exp", "pending"],
)
def test_invalid_claims_are_rejected(
    client: TestClient, make_token: TokenFactory, claims: dict[str, object]
) -> None:
    response = client.get("/v1/me", headers=internal_headers(make_token(**claims)))

    assert response.status_code == 401


def test_token_signed_by_another_key_is_rejected(
    client: TestClient, make_token: TokenFactory
) -> None:
    forged = make_token(key=rsa.generate_private_key(public_exponent=65537, key_size=2048))

    assert client.get("/v1/me", headers=internal_headers(forged)).status_code == 401


def test_hmac_algorithm_downgrade_is_rejected(client: TestClient, make_token: TokenFactory) -> None:
    forged = make_token(key="a-guessable-shared-secret-of-sufficient-length", algorithm="HS256")

    assert client.get("/v1/me", headers=internal_headers(forged)).status_code == 401


def test_unsigned_token_is_rejected(client: TestClient) -> None:
    unsigned = "eyJhbGciOiJub25lIiwia2lkIjoidGVzdC1rZXkifQ.eyJzdWIiOiJ1c2VyXzEyMyJ9."

    assert client.get("/v1/me", headers=internal_headers(unsigned)).status_code == 401


def test_garbage_token_is_rejected(client: TestClient) -> None:
    assert client.get("/v1/me", headers=internal_headers("not-a-jwt")).status_code == 401


def test_auth_endpoints_return_503_when_clerk_is_not_configured(
    settings: Settings, make_token: TokenFactory
) -> None:
    unconfigured = settings.model_copy(update={"clerk_issuer": None})
    client = TestClient(create_app(unconfigured))

    response = client.get("/v1/me", headers=internal_headers(make_token()))

    assert response.status_code == 503


class TestJwksCache:
    def test_unknown_kid_refetches_at_most_once_per_interval(self, jwk_set: PyJWKSet) -> None:
        calls = 0
        now = 1000.0

        def fetch() -> PyJWKSet:
            nonlocal calls
            calls += 1
            return jwk_set

        cache = JwksCache(fetch, min_refresh_interval_s=60, clock=lambda: now)

        for _ in range(5):
            with pytest.raises(InvalidTokenError):
                cache.key_for("unknown")
        assert calls == 1

        now += 61
        with pytest.raises(InvalidTokenError):
            cache.key_for("unknown")
        assert calls == 2

    def test_known_kid_is_served_from_cache(self, jwk_set: PyJWKSet) -> None:
        calls = 0

        def fetch() -> PyJWKSet:
            nonlocal calls
            calls += 1
            return jwk_set

        cache = JwksCache(fetch)
        for _ in range(3):
            cache.key_for("test-key")
        assert calls == 1

    def test_fetch_failure_is_reported_as_unavailable(self) -> None:
        def fetch() -> PyJWKSet:
            raise OSError("network down")

        with pytest.raises(AuthUnavailableError):
            JwksCache(fetch).key_for("test-key")
