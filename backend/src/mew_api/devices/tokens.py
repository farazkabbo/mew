"""Device tokens and the one-time link codes that issue them.

How a desktop app gets a token (decision 8, PKCE-style):

1. The desktop app makes a random `verifier` and gives the web page only its hash, the
   `challenge`.
2. The signed-in page asks for a link code bound to that challenge and the user (`LinkCodes.issue`).
3. The page hands the code to the desktop app, which redeems it with the verifier
   (`LinkCodes.redeem`). A stolen code is useless without the verifier, which never leaves the
   desktop app.

The token itself is opaque random (256 bits), returned once; only its SHA-256 hash is stored.
"""

import base64
import hashlib
import hmac
import re
import secrets
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass

TOKEN_PREFIX = "mewdt_"  # noqa: S105 (a public marker, not a secret)
"""Makes tokens recognisable (to people and to secret scanners) without revealing anything."""

TOKEN_PATTERN = re.compile(r"^mewdt_[A-Za-z0-9_-]{43}$")
VERIFIER_PATTERN = re.compile(r"^[A-Za-z0-9._~-]{43,128}$")  # RFC 7636 §4.1
CHALLENGE_PATTERN = re.compile(r"^[A-Za-z0-9_-]{43}$")  # base64url SHA-256, no padding
CODE_PATTERN = re.compile(r"^[A-Za-z0-9_-]{32}$")

LINK_CODE_TTL_S = 60.0
MAX_PENDING_CODES_PER_USER = 5


def new_device_token() -> str:
    return TOKEN_PREFIX + secrets.token_urlsafe(32)


def hash_token(token: str) -> str:
    """Lowercase hex SHA-256: what the database stores and looks tokens up by."""
    return hashlib.sha256(token.encode("ascii")).hexdigest()


def challenge_for(verifier: str) -> str:
    """The PKCE S256 challenge of a verifier: base64url(SHA-256(verifier)) without padding."""
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")


def verifier_matches(verifier: str, challenge: str) -> bool:
    return hmac.compare_digest(challenge_for(verifier), challenge)


@dataclass(frozen=True, slots=True)
class LinkGrant:
    """Who a redeemed link code was issued to."""

    user_id: str
    # The user was the development-only local user (no Clerk): their device lives in memory.
    local: bool


@dataclass(slots=True)
class _Pending:
    grant: LinkGrant
    challenge: str
    expires_at: float


class LinkCodes:
    """One-time link codes, held in memory for a minute (single API instance, like the web
    app's rate limiter). Each code can be redeemed once: a wrong verifier burns it too, so a
    stolen code can't be used to guess."""

    def __init__(self, clock: Callable[[], float] = time.monotonic) -> None:
        self._clock = clock
        self._pending: dict[str, _Pending] = {}
        self._lock = threading.Lock()

    def issue(self, grant: LinkGrant, challenge: str) -> str:
        now = self._clock()
        code = secrets.token_urlsafe(24)
        with self._lock:
            self._forget_expired(now)
            mine = [c for c, p in self._pending.items() if p.grant.user_id == grant.user_id]
            # Keep the newest few: a user retrying is fine, a script minting thousands isn't.
            for old in mine[: max(0, len(mine) - MAX_PENDING_CODES_PER_USER + 1)]:
                del self._pending[old]
            self._pending[code] = _Pending(grant, challenge, now + LINK_CODE_TTL_S)
        return code

    def redeem(self, code: str, verifier: str) -> LinkGrant | None:
        with self._lock:
            pending = self._pending.pop(code, None)
        if pending is None or self._clock() >= pending.expires_at:
            return None
        return pending.grant if verifier_matches(verifier, pending.challenge) else None

    def _forget_expired(self, now: float) -> None:
        for code in [c for c, p in self._pending.items() if now >= p.expires_at]:
            del self._pending[code]
