"""Moments (K8, docs/NOTEBOOKS_K.md §4.6-4.7): filing a saved screen moment, its check question,
and its voice for Replay.

Who calls what (every route also needs the internal secret):
- the desktop app, through the web server, with its device token: file a moment (where it goes
  when nothing was said); with the secret key, filtered to the token's owner;
- the signed-in owner (Clerk token): the checks due, one check with its key (the web server
  grades with it), its new schedule, clearing them; and the moment's audio.
Logs carry ids, counts and methods only: never titles, hints or text.
"""

import logging
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Header, HTTPException, Path, Request, Response, status

from ..config import Settings
from ..deps import Caller, CurrentCaller, SettingsDep
from ..moments.audio import (
    MAX_CLIP_BYTES,
    MEDIA_TYPE,
    AudioStore,
    MemoryAudioStore,
    SupabaseAudioStore,
)
from ..moments.filing import Decision, Moment, Node, decide, path_of, unsorted_node_id
from ..moments.models import (
    CheckSchedule,
    ChecksDue,
    CheckView,
    CheckWithKey,
    FiledPlace,
    FilingRequest,
    FilingResponse,
    QuizCardsRequest,
    QuizCardsResponse,
)
from ..moments.store import (
    CheckRow,
    MemoryMomentStore,
    MomentStore,
    QuizCard,
    SupabaseMomentStore,
)
from ..notebooks.store import NotebookTreeStore, SupabaseNotebookTreeStore
from ..supabase_rest import StoreError
from .devices import screen_device

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/moments", tags=["moments"])


def _unavailable() -> HTTPException:
    return HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Moments aren't configured")


def _call[T](fn: Callable[[], T]) -> T:
    try:
        return fn()
    except PermissionError:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Unauthorized") from None
    except StoreError:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, "Moment storage unavailable") from None


def service_moments(request: Request, settings: Settings, local: bool) -> MomentStore:
    """For the desktop app's calls: the secret key (every query is filtered to the owner)."""
    if local:
        store: MemoryMomentStore = request.app.state.local_moments
        return store
    if not settings.supabase_url or settings.supabase_secret_key is None:
        raise _unavailable()
    return SupabaseMomentStore(
        settings.supabase_url,
        api_key=settings.supabase_secret_key.get_secret_value(),
        user_token=None,
    )


def owner_moments(request: Request, caller: Caller, settings: Settings) -> MomentStore:
    if caller.is_local:
        store: MemoryMomentStore = request.app.state.local_moments
        return store
    if not settings.supabase_url or not settings.supabase_publishable_key:
        raise _unavailable()
    return SupabaseMomentStore(
        settings.supabase_url, api_key=settings.supabase_publishable_key, user_token=caller.token
    )


def service_tree(request: Request, settings: Settings, local: bool) -> NotebookTreeStore:
    """The student's tree with the secret key (for filing; always read for one owner)."""
    if local:
        tree: NotebookTreeStore = request.app.state.local_notebooks
        return tree
    if not settings.supabase_url or settings.supabase_secret_key is None:
        raise _unavailable()
    return SupabaseNotebookTreeStore(
        settings.supabase_url,
        api_key=settings.supabase_secret_key.get_secret_value(),
        user_token=None,
    )


# ─── Filing (the desktop app) ────────────────────────────────────────────────────────────────


@router.post("/file")
def file_moment(
    body: FilingRequest,
    request: Request,
    settings: SettingsDep,
    x_mew_device_token: Annotated[str | None, Header()] = None,
) -> FilingResponse:
    """Where an unspoken moment goes (§4.6): source memory, content, subject, sticky, Unsorted."""
    device = screen_device(x_mew_device_token, request, settings)
    context = filing_context(request, settings, device.local, device.user_id)
    moment = Moment(body.subject, tuple(body.hints), body.source_key)
    decision = context.decide(moment, sticky_id=body.sticky_node_id)
    nodes = context.nodes
    # Method and score only: never the place or what matched.
    logger.info("Filed a moment (%s, %.2f)", decision.method, decision.score)
    path = path_of(decision.node_id, nodes) or ["Unsorted"]
    return FilingResponse(
        method=decision.method,
        node_id=decision.node_id,
        path=path,
        score=decision.score,
        matched=decision.matched,
        alternatives=[
            FiledPlace(node_id=n, path=p) for n in decision.alternatives if (p := path_of(n, nodes))
        ],
        new_notebook=decision.new_notebook,
    )


@dataclass
class FilingContext:
    """One student's tree and texts, read once to file one moment or a batch of them."""

    user: str
    nodes: list[Node]
    texts: dict[UUID, list[str]]
    moments: MomentStore

    def decide(self, moment: Moment, sticky_id: UUID | None = None) -> Decision:
        memory, corrections = _call(
            lambda: self.moments.filing_inputs(self.user, moment.source_key)
        )
        return decide(
            moment,
            self.nodes,
            self.texts,
            unsorted_id=unsorted_node_id(self.user),
            memory=memory,
            corrections=corrections,
            sticky_id=sticky_id,
        )


def filing_context(request: Request, settings: Settings, local: bool, user: str) -> FilingContext:
    tree = service_tree(request, settings, local)
    moments = service_moments(request, settings, local)
    nodes = [
        Node(n.id, n.parent_id, n.title, n.position, n.subject, n.deleted_at is not None)
        for n in _call(lambda: tree.tree(user))
    ]
    return FilingContext(user, nodes, _call(lambda: moments.node_texts(user)), moments)


# ─── "Quiz me on this" (the desktop app, S6) ───────────────────────────────────────────────


@router.post("/device/quiz")
def add_quiz_cards(
    body: QuizCardsRequest,
    request: Request,
    settings: SettingsDep,
    x_mew_device_token: Annotated[str | None, Header()] = None,
) -> QuizCardsResponse:
    """Keeps each question as a recall card (due tomorrow, within today's 15 new)."""
    device = screen_device(x_mew_device_token, request, settings)
    store = service_moments(request, settings, device.local)
    cards = [QuizCard(q.question, list(q.hints)) for q in body.questions]
    ids = _call(
        lambda: store.add_quiz_checks(
            device.user_id, cards, body.source_title, body.source_app, datetime.now(UTC)
        )
    )
    logger.info("Kept %d quiz cards", len(ids))
    return QuizCardsResponse(check_ids=ids)


@router.get("/device/checks/{check_id}")
def device_check(
    check_id: UUID,
    request: Request,
    settings: SettingsDep,
    x_mew_device_token: Annotated[str | None, Header()] = None,
) -> CheckWithKey:
    """A quiz card with its key, for the web server to grade an answer given on screen. Only
    "quiz me on this" cards: a saved moment's check is answered in the review."""
    device = screen_device(x_mew_device_token, request, settings)
    store = service_moments(request, settings, device.local)
    check = _call(lambda: store.get_check(device.user_id, check_id))
    if check is None or check.origin != "screen_quiz":
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    return _with_key(check)


def _with_key(check: CheckRow) -> CheckWithKey:
    return CheckWithKey(
        **_view(check).model_dump(),
        answer_key=check.answer_key,
        answer_latex=check.answer_latex,
        fsrs_state=check.fsrs_state,
        reps=check.reps,
    )


# ─── Checks (the owner) ──────────────────────────────────────────────────────────────────────


def _view(check: CheckRow) -> CheckView:
    return CheckView(
        id=check.id,
        clip_id=check.clip_id,
        origin="screen_quiz" if check.origin == "screen_quiz" else "moment",
        source_title=check.source_title,
        merged_clip_ids=check.merged_clip_ids,
        node_id=check.node_id,
        prompt=check.prompt,
        kind=check.kind,
        choices=check.choices,
        concept_hints=check.concept_hints,
        is_new=check.reps == 0,
        due_at=check.due_at or check.created_at,
        created_at=check.created_at,
    )


@router.get("/checks/due")
def checks_due(request: Request, caller: CurrentCaller, settings: SettingsDep) -> ChecksDue:
    """Every active check, soonest due first (the web server filters what's due now): queued
    checks become active first, as far as today's 15 new allow."""
    store = owner_moments(request, caller, settings)
    checks = _call(lambda: store.due_checks(caller.user_id, datetime.now(UTC)))
    return ChecksDue(checks=[_view(c) for c in checks])


@router.get("/checks/{check_id}")
def get_check(
    check_id: UUID, request: Request, caller: CurrentCaller, settings: SettingsDep
) -> CheckWithKey:
    store = owner_moments(request, caller, settings)
    check = _call(lambda: store.get_check(caller.user_id, check_id))
    if check is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    return _with_key(check)


@router.patch("/checks/{check_id}", status_code=status.HTTP_204_NO_CONTENT)
def schedule_check(
    check_id: UUID,
    body: CheckSchedule,
    request: Request,
    caller: CurrentCaller,
    settings: SettingsDep,
) -> None:
    store = owner_moments(request, caller, settings)
    if not _call(
        lambda: store.schedule(caller.user_id, check_id, body.fsrs_state, body.due_at, body.reps)
    ):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")


@router.delete("/checks", status_code=status.HTTP_204_NO_CONTENT)
def clear_checks(request: Request, caller: CurrentCaller, settings: SettingsDep) -> None:
    """ "Quiz me on things I save" turned off, with "clear them": every moment check goes."""
    store = owner_moments(request, caller, settings)
    _call(lambda: store.clear_checks(caller.user_id))


# ─── Audio (the owner) ───────────────────────────────────────────────────────────────────────

Turn = Annotated[int, Path(ge=0, le=2)]
Step = Annotated[int, Path(ge=0, le=4)]


def _audio(request: Request, caller: Caller, settings: Settings) -> AudioStore:
    if caller.is_local:
        store: MemoryAudioStore = request.app.state.local_audio
        return store
    if not settings.supabase_url or not settings.supabase_publishable_key:
        raise _unavailable()
    return SupabaseAudioStore(
        settings.supabase_url, api_key=settings.supabase_publishable_key, user_token=caller.token
    )


@router.put("/{clip_id}/audio/{turn}/{step}", status_code=status.HTTP_204_NO_CONTENT)
async def put_audio(
    clip_id: UUID,
    turn: Turn,
    step: Step,
    request: Request,
    caller: CurrentCaller,
    settings: SettingsDep,
) -> None:
    """A step's voice as played (16-bit PCM, 24 kHz), for Replay."""
    if request.headers.get("content-type") != MEDIA_TYPE:
        raise HTTPException(status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, "PCM audio only")
    pcm = await request.body()
    if not pcm or len(pcm) > MAX_CLIP_BYTES or len(pcm) % 2:
        raise HTTPException(status.HTTP_413_CONTENT_TOO_LARGE, "Invalid audio")
    store = _audio(request, caller, settings)
    try:
        _call(lambda: store.put(caller.user_id, clip_id, turn, step, pcm))
    except ValueError:
        raise HTTPException(status.HTTP_413_CONTENT_TOO_LARGE, "Too much audio") from None


@router.get("/{clip_id}/audio/{turn}/{step}")
def get_audio(
    clip_id: UUID,
    turn: Turn,
    step: Step,
    request: Request,
    caller: CurrentCaller,
    settings: SettingsDep,
) -> Response:
    store = _audio(request, caller, settings)
    pcm = _call(lambda: store.get(caller.user_id, clip_id, turn, step))
    if pcm is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    return Response(
        content=pcm,
        media_type=MEDIA_TYPE,
        headers={"Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff"},
    )
