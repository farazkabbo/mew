"""Note lines (Notes Check N1): the signed-in student's browser syncs the recognised text of a
notebook page after it changes. Everything runs as the student (Clerk token, RLS)."""

import logging
from collections.abc import Callable
from uuid import UUID

from fastapi import APIRouter, HTTPException, Request, status

from ..config import Settings
from ..deps import Caller, CurrentCaller, SettingsDep
from ..notes.embedding import embed_changed_lines
from ..notes.models import NotePageSync, NotePageSyncResult
from ..notes.store import NoteLineStore, SupabaseNoteLineStore
from ..supabase_rest import StoreError
from .courses import _embedder

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/notes", tags=["notes"])


def note_store(request: Request, caller: Caller, settings: Settings) -> NoteLineStore:
    """The caller's note lines: RLS-scoped Supabase when signed in, memory in local mode."""
    if caller.is_local:
        store: NoteLineStore = request.app.state.local_notes
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
