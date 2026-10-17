"""Application factory. Run with: uvicorn --factory mew_api.main:create_app"""

import logging
from collections.abc import Awaitable, Callable

from fastapi import APIRouter, Depends, FastAPI, Request, Response
from starlette.middleware.trustedhost import TrustedHostMiddleware

from . import __version__
from .auth import ClerkTokenVerifier, JwksCache, TokenVerifier
from .config import Settings
from .deps import require_internal_caller
from .routes import health, me

logger = logging.getLogger(__name__)

_DOCS_PATHS = ("/docs", "/openapi.json")


def create_app(
    settings: Settings | None = None,
    token_verifier: TokenVerifier | None = None,
) -> FastAPI:
    settings = settings or Settings()
    logging.basicConfig(level=logging.DEBUG if settings.is_development else logging.INFO)

    app = FastAPI(
        title="Mew API",
        version=__version__,
        # Interactive docs only in development: no free schema map for attackers in production.
        docs_url="/docs" if settings.is_development else None,
        openapi_url="/openapi.json" if settings.is_development else None,
        redoc_url=None,
    )
    app.state.settings = settings
    app.state.token_verifier = token_verifier or _build_verifier(settings)

    app.add_middleware(TrustedHostMiddleware, allowed_hosts=list(settings.trusted_hosts))
    app.middleware("http")(_security_headers)

    v1 = APIRouter(prefix="/v1", dependencies=[Depends(require_internal_caller)])
    v1.include_router(me.router)
    app.include_router(health.router)
    app.include_router(v1)
    return app


def _build_verifier(settings: Settings) -> TokenVerifier | None:
    if settings.clerk_issuer is None:
        logger.warning("CLERK_ISSUER is not set; authenticated endpoints will return 503")
        return None
    return ClerkTokenVerifier(
        issuer=settings.clerk_issuer,
        authorized_parties=settings.clerk_authorized_parties,
        jwks=JwksCache.from_url(f"{settings.clerk_issuer}/.well-known/jwks.json"),
    )


async def _security_headers(
    request: Request, call_next: Callable[[Request], Awaitable[Response]]
) -> Response:
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["Cache-Control"] = "no-store"
    if not request.url.path.startswith(_DOCS_PATHS):
        response.headers["Content-Security-Policy"] = "default-src 'none'; frame-ancestors 'none'"
    return response
