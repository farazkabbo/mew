"""Live annotations (K9, docs/NOTEBOOKS_K.md §7): the student's device sends each mark it made
(and again when it resolves or is dismissed), with the student's own token. Logs carry counts
only: never the text, the note or which page."""

import logging

from fastapi import APIRouter, HTTPException, Request, status

from ..annotations.models import AnnotationSync, AnnotationSyncResult
from ..annotations.store import AnnotationStore, MemoryAnnotationStore, SupabaseAnnotationStore
from ..deps import CurrentCaller, SettingsDep
from ..supabase_rest import StoreError

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/annotations", tags=["annotations"])


def _store(request: Request, caller: CurrentCaller, settings: SettingsDep) -> AnnotationStore:
    if caller.is_local:
        store: MemoryAnnotationStore = request.app.state.local_annotations
        return store
    if not settings.supabase_url or not settings.supabase_publishable_key:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Annotations aren't configured")
    return SupabaseAnnotationStore(
        settings.supabase_url, api_key=settings.supabase_publishable_key, user_token=caller.token
    )


@router.put("")
def sync_annotations(
    body: AnnotationSync, request: Request, caller: CurrentCaller, settings: SettingsDep
) -> AnnotationSyncResult:
    store = _store(request, caller, settings)
    try:
        saved = store.upsert(caller.user_id, body.annotations)
    except PermissionError:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Unauthorized") from None
    except StoreError:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, "Annotation storage unavailable") from None
    logger.info("Synced annotations: %d sent, %d saved", len(body.annotations), saved)
    return AnnotationSyncResult(saved=saved)
