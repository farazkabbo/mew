"""Clerk session-token verification (RS256 via the instance JWKS)."""

import threading
import time
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from typing import Any, Protocol

import jwt
from jwt import PyJWK, PyJWKClient, PyJWKSet


class InvalidTokenError(Exception):
    """The token is malformed, expired, mis-signed or not meant for us. Maps to 401."""


class AuthUnavailableError(Exception):
    """Signing keys could not be fetched, so no verdict is possible. Maps to 503."""


@dataclass(frozen=True, slots=True)
class Principal:
    user_id: str
    session_id: str | None


class TokenVerifier(Protocol):
    def verify(self, token: str) -> Principal: ...


class JwksCache:
    """Caches signing keys by `kid`.

    An unknown `kid` triggers a refetch at most once per `min_refresh_interval_s`, so forged
    tokens can't be used to hammer the JWKS endpoint.
    """

    def __init__(
        self,
        fetch: Callable[[], PyJWKSet],
        *,
        min_refresh_interval_s: float = 60.0,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._fetch = fetch
        self._min_refresh_interval_s = min_refresh_interval_s
        self._clock = clock
        self._keys: dict[str, PyJWK] = {}
        self._last_refresh: float | None = None
        self._lock = threading.Lock()

    @classmethod
    def from_url(cls, url: str) -> "JwksCache":
        client = PyJWKClient(url, cache_jwk_set=False, cache_keys=False, timeout=5)
        return cls(lambda: client.get_jwk_set(refresh=True))

    def key_for(self, kid: str) -> PyJWK:
        with self._lock:
            key = self._keys.get(kid)
            if key is None and self._may_refresh():
                self._refresh()
                key = self._keys.get(kid)
        if key is None:
            raise InvalidTokenError("unknown signing key")
        return key

    def _may_refresh(self) -> bool:
        return (
            self._last_refresh is None
            or self._clock() - self._last_refresh >= self._min_refresh_interval_s
        )

    def _refresh(self) -> None:
        self._last_refresh = self._clock()
        try:
            jwk_set = self._fetch()
        except Exception as error:
            raise AuthUnavailableError("could not fetch signing keys") from error
        self._keys = {key.key_id: key for key in jwk_set.keys if key.key_id}


class ClerkTokenVerifier:
    _ALGORITHMS = ("RS256",)

    def __init__(
        self,
        *,
        issuer: str,
        authorized_parties: Iterable[str],
        jwks: JwksCache,
        leeway_s: int = 5,
    ) -> None:
        self._issuer = issuer
        self._authorized_parties = frozenset(authorized_parties)
        self._jwks = jwks
        self._leeway_s = leeway_s

    def verify(self, token: str) -> Principal:
        try:
            header = jwt.get_unverified_header(token)
        except jwt.PyJWTError as error:
            raise InvalidTokenError("malformed token") from error

        kid = header.get("kid")
        if header.get("alg") not in self._ALGORITHMS or not isinstance(kid, str):
            raise InvalidTokenError("unexpected token header")

        key = self._jwks.key_for(kid)
        try:
            claims: dict[str, Any] = jwt.decode(
                token,
                key.key,
                algorithms=list(self._ALGORITHMS),
                issuer=self._issuer,
                leeway=self._leeway_s,
                options={"require": ["exp", "iat", "iss", "sub"]},
            )
        except jwt.PyJWTError as error:
            raise InvalidTokenError(type(error).__name__) from error

        azp = claims.get("azp")
        if azp is not None and azp not in self._authorized_parties:
            raise InvalidTokenError("unauthorized party")
        if claims.get("sts") == "pending":
            raise InvalidTokenError("session pending")

        user_id = claims["sub"]
        if not isinstance(user_id, str) or not user_id:
            raise InvalidTokenError("invalid subject")
        session_id = claims.get("sid")
        return Principal(user_id, session_id if isinstance(session_id, str) else None)
