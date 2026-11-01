"""Clips saved from the screen (Screen Coach S3, decision 9).

Who calls what (every route also needs the internal secret: only the Next.js server calls this
API):
- the desktop app, through Next.js, with its device token: create a clip (the token is checked
  here again; a user id is never taken from the caller for this);
- the signed-in owner (Clerk token): read a clip and its image, note the notebook page built
  from it, delete it.
"""

import logging
from collections.abc import Callable
from datetime import UTC, datetime
from functools import partial
from typing import Annotated
from uuid import UUID, uuid4

from fastapi import APIRouter, Header, HTTPException, Request, Response, status

from ..clips.models import (
    ClipCreate,
    ClipCreated,
    ClipDestination,
    ClipPatch,
    ClipView,
    EntryAppend,
    FromScreenPage,
    SavedDestination,
    UnplacedEntries,
)
from ..clips.store import (
    ClipReader,
    ClipWriter,
    EntryFullError,
    FilingFacts,
    MemoryClipStore,
    SupabaseClipReader,
    SupabaseClipWriter,
)
from ..config import Settings
from ..deps import Caller, CurrentCaller, SettingsDep
from ..devices.models import VerifiedDevice
from ..moments.filing import Moment, Node, path_of, unsorted_node_id
from ..moments.models import MomentMove, Suggestion, Suggestions, SuggestionsRequest
from ..moments.source import source_key
from ..moments.store import MomentStore
from ..profiles.store import ProfileStore, SupabaseProfileStore
from ..supabase_rest import StoreError
from .devices import screen_device
from .moments import filing_context, service_moments, service_tree

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/clips", tags=["clips"])


def _local(request: Request) -> MemoryClipStore:
    store: MemoryClipStore = request.app.state.local_clips
    return store


def _unavailable() -> HTTPException:
    return HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Clips aren't configured")


def _writer(request: Request, settings: Settings, local: bool) -> ClipWriter:
    if local:
        return _local(request)
    if not settings.supabase_url or settings.supabase_secret_key is None:
        raise _unavailable()
    return SupabaseClipWriter(
        settings.supabase_url,
        api_key=settings.supabase_secret_key.get_secret_value(),
        user_token=None,
    )


def _reader(request: Request, caller: Caller, settings: Settings) -> ClipReader:
    if caller.is_local:
        return _local(request)
    if not settings.supabase_url or not settings.supabase_publishable_key:
        raise _unavailable()
    return SupabaseClipReader(
        settings.supabase_url, api_key=settings.supabase_publishable_key, user_token=caller.token
    )


def _call[T](fn: Callable[[], T]) -> T:
    """Maps store failures to safe HTTP errors (details stay in the logs)."""
    try:
        return fn()
    except PermissionError:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Unauthorized") from None
    except StoreError:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, "Clip storage unavailable") from None


def _not_found() -> HTTPException:
    return HTTPException(status.HTTP_404_NOT_FOUND, "Not found")


# ─── The desktop app ─────────────────────────────────────────────────────────────────────────


@router.post("", status_code=status.HTTP_201_CREATED)
def create_clip(
    body: ClipCreate,
    request: Request,
    settings: SettingsDep,
    x_mew_device_token: Annotated[str | None, Header()] = None,
) -> ClipCreated:
    """Stores a clip the student saved in the desktop app's preview, for the device's owner."""
    device = screen_device(x_mew_device_token, request, settings)
    try:
        image = body.image_bytes()
    except ValueError as error:
        code = (
            status.HTTP_413_CONTENT_TOO_LARGE
            if "too large" in str(error)
            else status.HTTP_400_BAD_REQUEST
        )
        raise HTTPException(code, "Invalid image") from None

    clip_id = uuid4()
    writer = _writer(request, settings, device.local)
    _call(lambda: writer.create(device.user_id, clip_id, body, image))
    # Ids and sizes only: never titles, links or text.
    logger.info("Saved a clip (%s, %d KB)", clip_id, len(image) // 1024)
    _remember_and_quiz(request, settings, device, clip_id, body)
    return ClipCreated(clip_id=clip_id)


def _remember_and_quiz(
    request: Request, settings: Settings, device: VerifiedDevice, clip_id: UUID, body: ClipCreate
) -> None:
    """K8: a saved moment's place becomes its source's memory, and its check question becomes a
    review card (when "Quiz me on things I save" is on). Best effort: the clip is saved either
    way, and a failure is logged without its content."""
    moments = service_moments(request, settings, device.local)
    node = body.destination.node_id if body.destination else None
    key = source_key(body.source.app, body.source.title, body.source.url)
    try:
        # Unsorted is where moments wait, not where their source belongs.
        if key and node and node != unsorted_node_id(device.user_id):
            moments.remember(device.user_id, key, node, corrected=False)
        moment = body.entry.moment if body.entry else None
        question = moment.check_question if moment else None
        if (
            body.entry
            and question
            and _profiles(request, settings, device).get_settings(device.user_id).quiz_saved_moments
        ):
            hints = list(body.entry.concept_hints)
            now = datetime.now(UTC)
            try:
                moments.add_check(device.user_id, clip_id, node, question, hints, now)
            except StoreError:
                # The place may not be on the server yet (local-first): the card still goes in.
                moments.add_check(device.user_id, clip_id, None, question, hints, now)
    except (StoreError, PermissionError):
        logger.warning("Couldn't file or quiz a saved moment (%s)", clip_id)


def _profiles(request: Request, settings: Settings, device: VerifiedDevice) -> ProfileStore:
    if device.local:
        store: ProfileStore = request.app.state.local_profiles
        return store
    if not settings.supabase_url or settings.supabase_secret_key is None:
        raise _unavailable()
    return SupabaseProfileStore(
        settings.supabase_url,
        api_key=settings.supabase_secret_key.get_secret_value(),
        user_token=None,
    )


@router.post("/entries/append")
def append_to_entry(
    body: EntryAppend,
    request: Request,
    settings: SettingsDep,
    x_mew_device_token: Annotated[str | None, Header()] = None,
) -> ClipCreated:
    """Adds a Circle & Ask follow-up to its session's entry (S3.2 §5): its explanation and its ink,
    no new picture. 404 if the session has no entry (yet), 413 if the entry is full."""
    device = screen_device(x_mew_device_token, request, settings)
    writer = _writer(request, settings, device.local)
    try:
        clip_id = _call(lambda: writer.append(device.user_id, body))
    except EntryFullError:
        raise HTTPException(status.HTTP_413_CONTENT_TOO_LARGE, "The entry is full") from None
    if clip_id is None:
        raise _not_found()
    # Ids and counts only: never the words.
    logger.info("Added to an entry (%s, %d strokes)", clip_id, len(body.strokes))
    return ClipCreated(clip_id=clip_id)


@router.post("/destination", status_code=status.HTTP_204_NO_CONTENT)
def move_clip(
    body: ClipDestination,
    request: Request,
    settings: SettingsDep,
    x_mew_device_token: Annotated[str | None, Header()] = None,
) -> None:
    """A saved clip or entry goes somewhere else in the notebook (K3): "Change" in the toast, or
    "save it to …" said after it was saved. The notebook moves it when it reads the clip again."""
    device = screen_device(x_mew_device_token, request, settings)
    writer = _writer(request, settings, device.local)
    before = _call(lambda: writer.filing_facts(device.user_id, body.clip_id))
    if not _call(lambda: writer.set_destination(device.user_id, body.clip_id, body.destination)):
        raise _not_found()
    # Ids only: never the place's title.
    logger.info("Moved a clip (%s)", body.clip_id)
    if before is not None and before.node_id != body.destination.node_id:
        moments = service_moments(request, settings, device.local)
        _learn_from_move(moments, device.user_id, body.clip_id, before, body.destination.node_id)


def _learn_from_move(
    moments: MomentStore, user: str, clip_id: UUID, before: FilingFacts, to_node: UUID
) -> None:
    """K8 "Change teaches": the source's moments go to the new place from now on, and similar
    moments aren't filed back where this one was taken from. Stored as data on the account. The
    moment's check goes with it. Moving out of Unsorted teaches the same, minus the correction
    (Unsorted was never a guess to correct)."""
    key = source_key(before.source_app, before.source_title, before.source_url)
    waited = before.node_id == unsorted_node_id(user)
    try:
        if key:
            moments.remember(user, key, to_node, corrected=True)
        if before.hints and not waited:
            moments.add_correction(user, before.node_id, to_node, before.hints)
    except (StoreError, PermissionError):
        logger.warning("Couldn't learn from a moved moment")
    try:
        moments.move_checks(user, clip_id, to_node)
    except (StoreError, PermissionError):
        # The place may not be on the server yet (local-first): the check keeps its old one.
        logger.warning("Couldn't move a moment's check")


# ─── The owner filing from the notebook (K8) ─────────────────────────────────────────────────
# The student's own Clerk token says who they are; the clip and the tree are then read and
# written with the secret key, filtered to them (destinations are the service's to write, as for
# the desktop app's calls).


@router.post("/suggestions")
def suggest_places(
    body: SuggestionsRequest, request: Request, caller: CurrentCaller, settings: SettingsDep
) -> Suggestions:
    """Unsorted's "File these" (§4.6): a place for each waiting moment, or none. Never Unsorted
    itself and never a notebook to make (that takes a tap on its own chip)."""
    writer = _writer(request, settings, caller.is_local)
    context = filing_context(request, settings, caller.is_local, caller.user_id)
    nodes = context.nodes
    unsorted = unsorted_node_id(caller.user_id)
    suggestions: list[Suggestion] = []
    for clip_id in dict.fromkeys(body.clip_ids):
        facts = _call(partial(writer.filing_facts, caller.user_id, clip_id))
        if facts is None:
            continue
        key = source_key(facts.source_app, facts.source_title, facts.source_url)
        decision = context.decide(Moment(facts.subject, tuple(facts.hints), key))
        node = decision.node_id if decision.method != "unsorted" else None
        if node is None and decision.alternatives:
            node = decision.alternatives[0]
        path = path_of(node, nodes) if node and node != unsorted else None
        suggestions.append(
            Suggestion(
                clip_id=clip_id,
                node_id=node if path else None,
                path=path or None,
                method=None if decision.method == "unsorted" or not path else decision.method,
                matched=decision.matched if path else None,
            )
        )
    # Counts only: never the places.
    placed = sum(1 for s in suggestions if s.node_id)
    logger.info("Suggested places for %d moments (%d placed)", len(suggestions), placed)
    return Suggestions(suggestions=suggestions)


@router.post("/{clip_id}/move", status_code=status.HTTP_204_NO_CONTENT)
def move_from_notebook(
    clip_id: UUID, body: MomentMove, request: Request, caller: CurrentCaller, settings: SettingsDep
) -> None:
    """The student moved a moment in the notebook (or accepted "File these"): its destination
    follows, so other devices put it there too, and filing learns from it like "Change"."""
    tree = service_tree(request, settings, caller.is_local)
    nodes = {n.id: n for n in _call(lambda: tree.tree(caller.user_id))}
    target = nodes.get(body.node_id)
    if target is None or target.deleted_at is not None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such place")
    writer = _writer(request, settings, caller.is_local)
    before = _call(lambda: writer.filing_facts(caller.user_id, clip_id))
    if before is None:
        raise _not_found()
    if before.node_id == body.node_id:
        return
    path = path_of(
        body.node_id,
        [Node(n.id, n.parent_id, n.title, n.position, n.subject, False) for n in nodes.values()],
    )
    destination = SavedDestination(
        node_id=body.node_id, page=FromScreenPage(kind="from_screen"), path=path or None
    )
    if not _call(lambda: writer.set_destination(caller.user_id, clip_id, destination)):
        raise _not_found()
    logger.info("Moved a moment from the notebook (%s)", clip_id)
    moments = service_moments(request, settings, caller.is_local)
    _learn_from_move(moments, caller.user_id, clip_id, before, body.node_id)


# ─── The owner ───────────────────────────────────────────────────────────────────────────────
# Responses leave out empty fields (None): the web app's schemas treat a missing title, link or
# follow-up question as absent, and refuse a null one.


@router.get("/unplaced")
def unplaced_entries(
    request: Request, caller: CurrentCaller, settings: SettingsDep
) -> UnplacedEntries:
    """Entries saved while no notebook was open to take them: the next one to open adds them."""
    reader = _reader(request, caller, settings)
    return UnplacedEntries(clip_ids=_call(lambda: reader.unplaced_entries(caller.user_id)))


@router.get("/{clip_id}", response_model_exclude_none=True)
def get_clip(
    clip_id: UUID, request: Request, caller: CurrentCaller, settings: SettingsDep
) -> ClipView:
    reader = _reader(request, caller, settings)
    clip = _call(lambda: reader.get(caller.user_id, clip_id))
    if clip is None:
        raise _not_found()
    return clip


@router.patch("/{clip_id}", response_model_exclude_none=True)
def note_page(
    clip_id: UUID,
    body: ClipPatch,
    request: Request,
    caller: CurrentCaller,
    settings: SettingsDep,
) -> ClipView:
    reader = _reader(request, caller, settings)
    clip = _call(lambda: reader.set_page(caller.user_id, clip_id, body.notebook_page_id))
    if clip is None:
        raise _not_found()
    return clip


@router.delete("/{clip_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_clip(
    clip_id: UUID, request: Request, caller: CurrentCaller, settings: SettingsDep
) -> None:
    reader = _reader(request, caller, settings)
    if not _call(lambda: reader.delete(caller.user_id, clip_id)):
        raise _not_found()


@router.get("/{clip_id}/image")
def clip_image(
    clip_id: UUID, request: Request, caller: CurrentCaller, settings: SettingsDep
) -> Response:
    reader = _reader(request, caller, settings)
    image = _call(lambda: reader.image(caller.user_id, clip_id))
    if image is None:
        raise _not_found()
    return Response(
        content=image,
        media_type="image/jpeg",
        headers={"Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff"},
    )
