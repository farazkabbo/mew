"""The notebook tree (K1, docs/NOTEBOOKS_K.md §2 and Decisions 14-19).

The student's browser keeps the tree (local-first) and syncs it here with its Clerk token:
- GET the server's copy (another device's edits arrive this way);
- PUT its changes; each node comes back saved, renamed (a sibling had its name), stale (a later
  edit is kept) or rejected (too deep, a loop, not theirs), with the server's copy, so the device
  can show a rename and undo a refused move.
Only titles and places are synced, never page content.
"""

import logging
from collections import Counter
from collections.abc import Callable

from fastapi import APIRouter, HTTPException, Request, status

from ..config import Settings
from ..deps import Caller, CurrentCaller, SettingsDep
from ..notebooks.models import NotebookTreeSync, NotebookTreeSyncResult, NotebookTreeView
from ..notebooks.store import NotebookTreeStore, SupabaseNotebookTreeStore
from ..supabase_rest import StoreError

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/notebooks", tags=["notebooks"])


def tree_store(request: Request, caller: Caller, settings: Settings) -> NotebookTreeStore:
    """The caller's tree: RLS-scoped Supabase when signed in, memory in local mode."""
    if caller.is_local:
        store: NotebookTreeStore = request.app.state.local_notebooks
        return store
    if not settings.supabase_url or not settings.supabase_publishable_key:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Notebooks aren't configured")
    return SupabaseNotebookTreeStore(
        settings.supabase_url, api_key=settings.supabase_publishable_key, user_token=caller.token
    )


def _call[T](fn: Callable[[], T]) -> T:
    """Maps store failures to safe HTTP errors (details stay in the logs)."""
    try:
        return fn()
    except PermissionError:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Unauthorized") from None
    except StoreError:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, "Notebook storage unavailable") from None


@router.get("/tree")
def get_tree(request: Request, caller: CurrentCaller, settings: SettingsDep) -> NotebookTreeView:
    store = tree_store(request, caller, settings)
    return NotebookTreeView(nodes=_call(lambda: store.tree(caller.user_id)))


@router.put("/tree")
def sync_tree(
    body: NotebookTreeSync, request: Request, caller: CurrentCaller, settings: SettingsDep
) -> NotebookTreeSyncResult:
    store = tree_store(request, caller, settings)
    results = _call(lambda: store.sync(caller.user_id, body))
    # Counts only: never titles.
    counts = Counter(r.status for r in results)
    logger.info(
        "Synced a notebook tree: %d saved, %d renamed, %d stale, %d rejected, %d purged",
        counts["saved"],
        counts["renamed"],
        counts["stale"],
        counts["rejected"],
        len(body.removed),
    )
    return NotebookTreeSyncResult(results=results)
