"""Request dependencies: settings access, internal-caller check and the authenticated user."""

import hmac
import logging
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
