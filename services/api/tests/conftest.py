import json
import time
from collections.abc import Callable
from typing import Any

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import FastAPI
from fastapi.testclient import TestClient
from jwt import PyJWKSet
from jwt.algorithms import RSAAlgorithm

from mew_api.auth import ClerkTokenVerifier, JwksCache
from mew_api.config import Settings
from mew_api.main import create_app

ISSUER = "https://test-instance.clerk.accounts.dev"
APP_ORIGIN = "http://localhost:3000"
INTERNAL_SECRET = "x" * 40
KID = "test-key"

TokenFactory = Callable[..., str]


@pytest.fixture(scope="session")
def signing_key() -> rsa.RSAPrivateKey:
    return rsa.generate_private_key(public_exponent=65537, key_size=2048)


@pytest.fixture(scope="session")
def jwk_set(signing_key: rsa.RSAPrivateKey) -> PyJWKSet:
    jwk: dict[str, Any] = json.loads(RSAAlgorithm.to_jwk(signing_key.public_key()))
    jwk.update(kid=KID, alg="RS256", use="sig")
    return PyJWKSet.from_dict({"keys": [jwk]})


@pytest.fixture
def make_token(signing_key: rsa.RSAPrivateKey) -> TokenFactory:
    def factory(*, kid: str = KID, key: Any = None, algorithm: str = "RS256", **claims: Any) -> str:
        now = int(time.time())
        payload: dict[str, Any] = {
            "iss": ISSUER,
            "sub": "user_123",
            "sid": "sess_456",
            "azp": APP_ORIGIN,
            "iat": now,
            "nbf": now,
            "exp": now + 60,
        }
        payload.update(claims)
        payload = {k: v for k, v in payload.items() if v is not None}
        return jwt.encode(payload, key or signing_key, algorithm=algorithm, headers={"kid": kid})

    return factory


@pytest.fixture
def settings() -> Settings:
    return Settings(
        _env_file=None,
        app_env="test",
        internal_api_secret=INTERNAL_SECRET,
        clerk_issuer=ISSUER,
        clerk_authorized_parties=(APP_ORIGIN,),
        allowed_hosts=("testserver",),
    )


@pytest.fixture
def verifier(jwk_set: PyJWKSet) -> ClerkTokenVerifier:
    return ClerkTokenVerifier(
        issuer=ISSUER, authorized_parties=[APP_ORIGIN], jwks=JwksCache(lambda: jwk_set)
    )


@pytest.fixture
def app(settings: Settings, verifier: ClerkTokenVerifier) -> FastAPI:
    return create_app(settings, verifier)


@pytest.fixture
def client(app: FastAPI) -> TestClient:
    return TestClient(app)


def internal_headers(token: str | None = None) -> dict[str, str]:
    headers = {"X-Internal-Secret": INTERNAL_SECRET}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return headers
