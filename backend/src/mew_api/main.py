"""Application factory. Run with: uvicorn --factory mew_api.main:create_app"""

import logging
import threading
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager

from fastapi import APIRouter, Depends, FastAPI, Request, Response
from starlette.middleware.trustedhost import TrustedHostMiddleware

from . import __version__
from .annotations.store import MemoryAnnotationStore
from .auth import ClerkTokenVerifier, JwksCache, TokenVerifier
from .checker.sandbox import CheckerPool, limit_memory
from .clips.store import MemoryClipStore
from .config import Settings
from .courses.store import MemoryCourseStore
from .deps import require_internal_caller
from .devices.store import MemoryDeviceStore
from .devices.tokens import LinkCodes
from .mew_events.store import MemoryMewEventStore
from .moments.audio import MemoryAudioStore
from .moments.store import MemoryMomentStore, moment_texts
from .notebooks.store import MemoryNotebookTreeStore
from .notes.checks import MemoryCheckStore
from .notes.store import MemoryNoteLineStore
from .pdfs.store import MemoryPdfStore
from .profiles.store import MemoryProfileStore
from .routes import (
    annotations,
    check,
    clips,
    courses,
    devices,
    health,
    learner,
    me,
    mew_events,
    moments,
    notebooks,
    notes,
    pdfs,
    walkthroughs,
)
from .routes import settings as user_settings
from .walkthroughs.store import MemoryWalkthroughStore

logger = logging.getLogger(__name__)

_DOCS_PATHS = ("/docs", "/openapi.json")


def create_app(
    settings: Settings | None = None,
    token_verifier: TokenVerifier | None = None,
    checker: CheckerPool | None = None,
    *,
    warm_checker: bool = True,
) -> FastAPI:
    settings = settings or Settings()
    logging.basicConfig(level=logging.DEBUG if settings.is_development else logging.INFO)
    pool = checker or CheckerPool()
    # PDF parsing gets its own sandboxed worker (untrusted files; 1 GB address-space cap).
    ingest_pool = CheckerPool(workers=1, initializer=limit_memory, initargs=(1024**3,))

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        if warm_checker:
            # SymPy takes seconds to import: start the workers now, off the event loop.
            threading.Thread(target=pool.warm, name="checker-warmup", daemon=True).start()
        yield
        pool.close()
        ingest_pool.close()

    app = FastAPI(
        lifespan=lifespan,
        title="Mew API",
        version=__version__,
        # Interactive docs only in development: no free schema map for attackers in production.
        docs_url="/docs" if settings.is_development else None,
        openapi_url="/openapi.json" if settings.is_development else None,
        redoc_url=None,
    )
    app.state.settings = settings
    app.state.token_verifier = token_verifier or _build_verifier(settings)
    app.state.checker = pool
    app.state.ingest_pool = ingest_pool
    # Courses for local mode (development without Clerk): kept in memory.
    app.state.local_courses = MemoryCourseStore()
    app.state.local_profiles = MemoryProfileStore()
    app.state.local_mew_events = MemoryMewEventStore()
    # Desktop sign-in (Screen Coach): one-time link codes, and local-mode devices.
    app.state.link_codes = LinkCodes()
    app.state.local_devices = MemoryDeviceStore()
    app.state.local_clips = MemoryClipStore()
    app.state.local_notes = MemoryNoteLineStore()
    app.state.local_checks = MemoryCheckStore(app.state.local_notes.pages_of)
    app.state.local_walkthroughs = MemoryWalkthroughStore()
    app.state.local_notebooks = MemoryNotebookTreeStore()
    app.state.local_pdfs = MemoryPdfStore()
    # Moments (K8): filing reads the local course passages and filed entries.
    app.state.local_moments = MemoryMomentStore(
        app.state.local_courses.node_passages,
        lambda user: moment_texts(app.state.local_clips.moment_rows(user)),
    )
    app.state.local_audio = MemoryAudioStore()
    app.state.local_annotations = MemoryAnnotationStore()

    app.add_middleware(TrustedHostMiddleware, allowed_hosts=list(settings.trusted_hosts))
    app.middleware("http")(_security_headers)

    v1 = APIRouter(prefix="/v1", dependencies=[Depends(require_internal_caller)])
    v1.include_router(me.router)
    v1.include_router(check.router)
    v1.include_router(pdfs.router)
    v1.include_router(courses.router)
    v1.include_router(learner.router)
    v1.include_router(user_settings.router)
    v1.include_router(mew_events.router)
    v1.include_router(devices.router)
    v1.include_router(clips.router)
    v1.include_router(notebooks.router)
    v1.include_router(notes.router)
    v1.include_router(walkthroughs.router)
    v1.include_router(moments.router)
    v1.include_router(annotations.router)
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
