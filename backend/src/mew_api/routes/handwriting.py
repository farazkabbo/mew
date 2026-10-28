"""The handwriting profile (K10, docs/NOTEBOOKS_K.md §8.3): the student's own samples, with their
own token. Logs carry counts only: never the text or the pictures."""

import logging

from fastapi import APIRouter, HTTPException, Request, status

from ..deps import CurrentCaller, SettingsDep
from ..handwriting.models import Deleted, SampleList, SampleRequest, Saved
from ..handwriting.store import HandwritingStore, MemoryHandwritingStore, SupabaseHandwritingStore
from ..supabase_rest import StoreError

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/handwriting", tags=["handwriting"])


def _store(request: Request, caller: CurrentCaller, settings: SettingsDep) -> HandwritingStore:
    if caller.is_local:
        store: MemoryHandwritingStore = request.app.state.local_handwriting
        return store
    if not settings.supabase_url or not settings.supabase_publishable_key:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Handwriting isn't configured")
    return SupabaseHandwritingStore(
        settings.supabase_url, api_key=settings.supabase_publishable_key, user_token=caller.token
    )


def _failed(error: Exception) -> HTTPException:
    if isinstance(error, PermissionError):
        return HTTPException(status.HTTP_401_UNAUTHORIZED, "Unauthorized")
    return HTTPException(status.HTTP_502_BAD_GATEWAY, "Handwriting storage unavailable")


@router.get("/samples")
def list_samples(request: Request, caller: CurrentCaller, settings: SettingsDep) -> SampleList:
    store = _store(request, caller, settings)
    try:
        return SampleList(samples=store.all(caller.user_id))
    except (PermissionError, StoreError) as error:
        raise _failed(error) from None


@router.post("/samples")
def add_samples(
    body: SampleRequest, request: Request, caller: CurrentCaller, settings: SettingsDep
) -> Saved:
    store = _store(request, caller, settings)
    try:
        saved = store.add(caller.user_id, body.samples)
    except (PermissionError, StoreError) as error:
        raise _failed(error) from None
    logger.info("Handwriting samples: %d sent, %d saved", len(body.samples), saved)
    return Saved(saved=saved)


@router.delete("/samples")
def delete_samples(request: Request, caller: CurrentCaller, settings: SettingsDep) -> Deleted:
    store = _store(request, caller, settings)
    try:
        deleted = store.delete_all(caller.user_id)
    except (PermissionError, StoreError) as error:
        raise _failed(error) from None
    logger.info("Handwriting samples reset: %d deleted", deleted)
    return Deleted(deleted=deleted)
