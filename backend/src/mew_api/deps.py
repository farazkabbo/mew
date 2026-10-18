"""Request dependencies: settings access, internal-caller check and the authenticated user."""

import hmac
import logging
from dataclasses import dataclass
from typing import Annotated

from fastapi import Depends, Header, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from .auth import AuthUnavailableError, InvalidTokenError, Principal, TokenVerifier
from .config import Settings

logger = logging.getLogger(__name__)

_bearer = HTTPBearer(auto_error=False)


def _unauthorized() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Unauthorized",
        headers={"WWW-Authenticate": "Bearer"},
    )


def get_settings(request: Request) -> Settings:
    settings: Settings = request.app.state.settings
    return settings


SettingsDep = Annotated[Settings, Depends(get_settings)]


def require_internal_caller(
    settings: SettingsDep,
    x_internal_secret: Annotated[str | None, Header()] = None,
) -> None:
    """Only the Next.js server holds this secret; the browser never calls this service directly."""
    expected = settings.internal_api_secret.get_secret_value().encode()
    if x_internal_secret is None or not hmac.compare_digest(x_internal_secret.encode(), expected):
        raise _unauthorized()


def current_principal(
    request: Request,
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)],
) -> Principal:
    # Sync on purpose: verification may fetch JWKS over the network, so FastAPI runs it in a thread.
    verifier: TokenVerifier | None = request.app.state.token_verifier
    if verifier is None:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Authentication is not configured")
    if credentials is None:
        raise _unauthorized()
    try:
        return verifier.verify(credentials.credentials)
    except InvalidTokenError as error:
        logger.info("Rejected session token: %s", error)
        raise _unauthorized() from None
    except AuthUnavailableError:
        logger.exception("Signing keys unavailable")
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE, "Authentication unavailable"
        ) from None


CurrentPrincipal = Annotated[Principal, Depends(current_principal)]


@dataclass(frozen=True)
class Caller:
    """Who a request acts for: a verified Clerk user (with their token, for RLS-scoped
    Supabase calls) or, in development only, the single local-mode user."""

    user_id: str
    token: str | None

    @property
    def is_local(self) -> bool:
        return self.token is None


LOCAL_USER_ID = "local"


def current_caller(
    request: Request,
    settings: SettingsDep,
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)],
    x_mew_local_user: Annotated[str | None, Header()] = None,
) -> Caller:
    """A signed-in user, or the local-mode user when the web app runs without Clerk. Local mode
    only exists in development: in production this header is ignored and a token is required.
    Only the Next.js server can call this API at all (internal secret), so the header can't be
    sent by a browser."""
    if credentials is not None:
        principal = current_principal(request, credentials)
        return Caller(principal.user_id, credentials.credentials)
    if settings.is_development and x_mew_local_user == LOCAL_USER_ID:
        return Caller(LOCAL_USER_ID, None)
    raise _unauthorized()


CurrentCaller = Annotated[Caller, Depends(current_caller)]
