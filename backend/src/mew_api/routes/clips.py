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
from typing import Annotated
from uuid import UUID, uuid4

from fastapi import APIRouter, Header, HTTPException, Request, Response, status

from ..clips.models import ClipCreate, ClipCreated, ClipPatch, ClipView, EntryAppend
from ..clips.store import (
    ClipReader,
    ClipWriter,
    EntryFullError,
    MemoryClipStore,
    SupabaseClipReader,
    SupabaseClipWriter,
)
from ..config import Settings
from ..deps import Caller, CurrentCaller, SettingsDep
from ..supabase_rest import StoreError
from .devices import screen_device

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
            status.HTTP_413_REQUEST_ENTITY_TOO_LARGE
            if "too large" in str(error)
            else status.HTTP_400_BAD_REQUEST
        )
        raise HTTPException(code, "Invalid image") from None

    clip_id = uuid4()
    writer = _writer(request, settings, device.local)
    _call(lambda: writer.create(device.user_id, clip_id, body, image))
    # Ids and sizes only: never titles, links or text.
    logger.info("Saved a clip (%s, %d KB)", clip_id, len(image) // 1024)
    return ClipCreated(clip_id=clip_id)


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
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "The entry is full") from None
    if clip_id is None:
        raise _not_found()
    # Ids and counts only: never the words.
    logger.info("Added to an entry (%s, %d strokes)", clip_id, len(body.strokes))
    return ClipCreated(clip_id=clip_id)


# ─── The owner ───────────────────────────────────────────────────────────────────────────────


@router.get("/{clip_id}")
def get_clip(
    clip_id: UUID, request: Request, caller: CurrentCaller, settings: SettingsDep
) -> ClipView:
    reader = _reader(request, caller, settings)
    clip = _call(lambda: reader.get(caller.user_id, clip_id))
    if clip is None:
        raise _not_found()
    return clip


@router.patch("/{clip_id}")
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
