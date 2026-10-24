"""Notes Check (docs/SCREEN_COACH_NOTES_CHECK.md).

- N1: the signed-in student's browser syncs the recognised text of a notebook page after it
  changes (Clerk token, RLS).
- N2: the notes related to what's on screen, for a check. From the browser (Clerk token), or from
  the desktop app (device token, checked here again; read with the secret key and always filtered
  on the device's owner).
- N3: keeping a check's findings (the same two ways), and the SymPy verifier for maths claims.
"""

import logging
from collections.abc import Callable
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Header, HTTPException, Request, status

from ..checker.sandbox import CheckerPool, CheckTimeoutError
from ..config import Settings
from ..courses.store import CourseNotFoundError, CourseStore
from ..courses.supabase_store import SupabaseCourseStore
from ..deps import Caller, CurrentCaller, SettingsDep
from ..devices.models import VerifiedDevice
from ..devices.tokens import TOKEN_PATTERN
from ..notes.checks import CheckStore, SupabaseCheckStore
from ..notes.embedding import embed_changed_lines
from ..notes.equivalence import compare_claims
from ..notes.models import (
    CheckCreate,
    CheckCreated,
    CoursePassage,
    EquivalenceRequest,
    EquivalenceResponse,
    FindingUpdate,
    FindingView,
    NotePageSync,
    NotePageSyncResult,
    RetrieveRequest,
    RetrieveResponse,
)
from ..notes.retrieval import retrieve
from ..notes.store import NoteStore, SupabaseNoteLineStore
from ..supabase_rest import StoreError
from .courses import _embedder, _retrieve, _user_store
from .devices import find_device

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/notes", tags=["notes"])

SCREEN_SCOPE = "screen"
#: Course passages given to the comparison as tie-breaking evidence (brief §5.4).
PASSAGES = 3
#: Wall-clock budget for one request's maths checks (like /v1/check/math).
EQUIVALENCE_TIMEOUT_S = 4.0


def note_store(request: Request, caller: Caller, settings: Settings) -> NoteStore:
    """The caller's note lines: RLS-scoped Supabase when signed in, memory in local mode."""
    if caller.is_local:
        store: NoteStore = request.app.state.local_notes
        return store
    if not settings.supabase_url or not settings.supabase_publishable_key:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Notes aren't configured")
    return SupabaseNoteLineStore(
        settings.supabase_url, api_key=settings.supabase_publishable_key, user_token=caller.token
    )


def _call[T](fn: Callable[[], T]) -> T:
    """Maps store failures to safe HTTP errors (details stay in the logs). The database also
    refuses lines while the notes_index setting is off: that's a 403 as well."""
    try:
        return fn()
    except PermissionError:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Not allowed") from None
    except StoreError:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, "Note storage unavailable") from None


# ─── N1: syncing a page ──────────────────────────────────────────────────────────────────────


@router.put("/pages/{page_id}/lines")
def sync_page(
    page_id: UUID,
    body: NotePageSync,
    request: Request,
    caller: CurrentCaller,
    settings: SettingsDep,
) -> NotePageSyncResult:
    store = note_store(request, caller, settings)
    stored = _call(lambda: store.stored_lines(caller.user_id, page_id))
    embeddings = embed_changed_lines(body.upsert, stored, _embedder(request, settings))
    _call(lambda: store.sync(caller.user_id, page_id, body, embeddings))
    # Counts only: never note text.
    logger.info(
        "Synced a note page: %d lines changed, %d removed, %d embedded",
        len(body.upsert),
        len(body.remove),
        len(embeddings.vectors),
    )
    return NotePageSyncResult(embedded=len(embeddings.vectors))


def delete_all_lines(request: Request, caller: Caller, settings: Settings) -> None:
    """Removes the server copy of the caller's notes (the notes_index setting went off)."""
    store = note_store(request, caller, settings)
    _call(lambda: store.delete_all(caller.user_id))


# ─── N2: the notes related to a screen ───────────────────────────────────────────────────────


@router.post("/retrieve")
def retrieve_for_student(
    body: RetrieveRequest, request: Request, caller: CurrentCaller, settings: SettingsDep
) -> RetrieveResponse:
    """For a check started in the notebook (e.g. a clip's page against the notes)."""
    store = note_store(request, caller, settings)
    courses = _user_store(request, caller, settings)
    return _retrieve_notes(request, settings, store, courses, caller.user_id, body)


@router.post("/device/retrieve")
def retrieve_for_device(
    body: RetrieveRequest,
    request: Request,
    settings: SettingsDep,
    x_mew_device_token: Annotated[str | None, Header()] = None,
) -> RetrieveResponse:
    """For "check my notes" in the desktop app. The device names no notebook or course (only the
    default scope or all notes), so it can never point the search anywhere but its owner's."""
    device = _verified_device(request, settings, x_mew_device_token)
    if body.scope.kind not in ("default", "all"):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Unsupported scope")

    if device.local:
        store: NoteStore = request.app.state.local_notes
        courses: CourseStore = request.app.state.local_courses
    else:
        url, key = _service_credentials(settings)
        store = SupabaseNoteLineStore(url, api_key=key, user_token=None)
        courses = SupabaseCourseStore(url, api_key=key, user_token=None)
    return _retrieve_notes(request, settings, store, courses, device.user_id, body)


# ─── N3: keeping a check's results, and the maths verifier ──────────────────────────────────


def student_checks(request: Request, caller: Caller, settings: Settings) -> CheckStore:
    """The caller's checks and findings: RLS-scoped Supabase when signed in, memory locally."""
    if caller.is_local:
        store: CheckStore = request.app.state.local_checks
        return store
    if not settings.supabase_url or not settings.supabase_publishable_key:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Notes aren't configured")
    return SupabaseCheckStore(
        settings.supabase_url, api_key=settings.supabase_publishable_key, user_token=caller.token
    )


@router.post("/checks", status_code=status.HTTP_201_CREATED)
def save_check_for_student(
    body: CheckCreate, request: Request, caller: CurrentCaller, settings: SettingsDep
) -> CheckCreated:
    return _saved(student_checks(request, caller, settings), caller.user_id, body)


@router.post("/device/checks", status_code=status.HTTP_201_CREATED)
def save_check_for_device(
    body: CheckCreate,
    request: Request,
    settings: SettingsDep,
    x_mew_device_token: Annotated[str | None, Header()] = None,
) -> CheckCreated:
    device = _verified_device(request, settings, x_mew_device_token)
    store: CheckStore
    if device.local:
        store = request.app.state.local_checks
    else:
        url, key = _service_credentials(settings)
        store = SupabaseCheckStore(url, api_key=key, user_token=None)
    return _saved(store, device.user_id, body)


def _saved(store: CheckStore, user: str, body: CheckCreate) -> CheckCreated:
    created = _call(lambda: store.save(user, body))
    # Counts only: never quotes.
    logger.info(
        "Saved a notes check: %d findings (%s), %d links",
        sum(1 for i in created.finding_ids if i),
        ", ".join(sorted({f.type for f in body.findings})) or "none",
        len(body.links),
    )
    return created


# ─── N5: resolving findings (the student's own session only) ──────────────────────────────


@router.get("/findings")
def open_findings(
    page_id: UUID, request: Request, caller: CurrentCaller, settings: SettingsDep
) -> list[FindingView]:
    """The page's findings still open (its marks, after a reload)."""
    store = student_checks(request, caller, settings)
    return _call(lambda: store.open_findings(caller.user_id, page_id))


@router.get("/findings/{finding_id}")
def get_finding(
    finding_id: UUID, request: Request, caller: CurrentCaller, settings: SettingsDep
) -> FindingView:
    store = student_checks(request, caller, settings)
    finding = _call(lambda: store.get_finding(caller.user_id, finding_id))
    if finding is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    return finding


@router.patch("/findings/{finding_id}")
def resolve_finding(
    finding_id: UUID,
    body: FindingUpdate,
    request: Request,
    caller: CurrentCaller,
    settings: SettingsDep,
) -> FindingView:
    """Records how an open finding was resolved; 409 if it isn't open any more."""
    store = student_checks(request, caller, settings)
    updated = _call(lambda: store.update_finding(caller.user_id, finding_id, body))
    if updated is None:
        exists = _call(lambda: store.get_finding(caller.user_id, finding_id))
        code = status.HTTP_409_CONFLICT if exists else status.HTTP_404_NOT_FOUND
        raise HTTPException(code, "Already resolved" if exists else "Not found")
    logger.info("Resolved a notes finding: %s", body.status)
    return updated


@router.post("/equivalence")
def equivalence(body: EquivalenceRequest, request: Request) -> EquivalenceResponse:
    """Whether each note claim and screen claim are the same maths (SymPy, never guessed).
    Stateless: nothing is stored or read."""
    pool: CheckerPool = request.app.state.checker
    pairs = [(p.note, p.screen) for p in body.pairs]
    try:
        verdicts = pool.run(compare_claims, pairs, timeout=EQUIVALENCE_TIMEOUT_S)
    except CheckTimeoutError:
        verdicts = ["unknown"] * len(pairs)
    return EquivalenceResponse(verdicts=verdicts)


def _verified_device(request: Request, settings: Settings, token: str | None) -> VerifiedDevice:
    """The desktop app's device, checked against the database on every request."""
    if token is None or not TOKEN_PATTERN.match(token):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Unauthorized")
    device = find_device(token, request, settings)
    if device is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Unauthorized")
    if SCREEN_SCOPE not in device.scopes:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Not allowed")
    return device


def _service_credentials(settings: Settings) -> tuple[str, str]:
    """The secret key, read-only here, for a device whose token was just verified: every query
    is filtered on the device's owner."""
    if not settings.supabase_url or settings.supabase_secret_key is None:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Notes aren't configured")
    return settings.supabase_url, settings.supabase_secret_key.get_secret_value()


def _retrieve_notes(
    request: Request,
    settings: Settings,
    store: NoteStore,
    courses: CourseStore,
    user: str,
    body: RetrieveRequest,
) -> RetrieveResponse:
    def passages(course_id: UUID, query: str) -> list[CoursePassage]:
        try:
            chunks = _retrieve(request, settings, courses, user, course_id, query, PASSAGES)
        except (CourseNotFoundError, StoreError, PermissionError):
            return []  # tie-breaking evidence is optional
        return [CoursePassage(page=c.page, heading=c.heading, text=c.text) for c in chunks]

    embedder = _embedder(request, settings)
    return _call(lambda: retrieve(store, embedder, user, body, passages))
