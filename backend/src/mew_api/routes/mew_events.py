"""Mew v2 (M10): keep the gate's decisions (only with the student's opt-in), list them for
labelling, label them, export the labelled ones, and delete them all."""

from datetime import datetime
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, HTTPException, Query, Request, status

from ..config import Settings
from ..deps import Caller, CurrentCaller, SettingsDep
from ..mew_events.models import (
    MAX_EXPORT,
    PAGE_SIZE,
    LabelUpdate,
    LogResult,
    MewEventCreate,
    MewEventPage,
)
from ..mew_events.store import MewEventStore, SupabaseMewEventStore
from .courses import _call
from .settings import profile_store

router = APIRouter(prefix="/mew/events", tags=["mew"])


def event_store(request: Request, caller: Caller, settings: Settings) -> MewEventStore:
    if caller.is_local:
        store: MewEventStore = request.app.state.local_mew_events
        return store
    if not settings.supabase_url or not settings.supabase_publishable_key:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Mew logging isn't configured")
    return SupabaseMewEventStore(
        settings.supabase_url, api_key=settings.supabase_publishable_key, user_token=caller.token
    )


@router.post("")
def log_event(
    body: MewEventCreate, request: Request, caller: CurrentCaller, settings: SettingsDep
) -> LogResult:
    """Keeps one decision if the student opted in (checked here, and again by RLS)."""
    profiles = profile_store(request, caller, settings)
    events = event_store(request, caller, settings)
    user = caller.user_id

    def log() -> LogResult:
        if not profiles.get_settings(user).mew_logging_opt_in:
            return LogResult(logged=False)
        stored_input = body.input.model_dump(by_alias=True, exclude_unset=True)
        return LogResult(logged=events.add_event(user, stored_input, body.stored_output()))

    return _call(log)


@router.get("")
def list_events(
    request: Request,
    caller: CurrentCaller,
    settings: SettingsDep,
    unlabeled: bool = False,
    before: datetime | None = None,
    limit: Annotated[int, Query(ge=1, le=PAGE_SIZE)] = PAGE_SIZE,
) -> MewEventPage:
    store = event_store(request, caller, settings)
    return MewEventPage(
        events=_call(
            lambda: store.list_events(
                caller.user_id, unlabeled_only=unlabeled, before=before, limit=limit
            )
        )
    )


@router.get("/labeled")
def labeled_events(request: Request, caller: CurrentCaller, settings: SettingsDep) -> MewEventPage:
    """Every labelled decision (oldest first, up to MAX_EXPORT): the student's dataset."""
    store = event_store(request, caller, settings)
    return MewEventPage(events=_call(lambda: store.labeled_events(caller.user_id, MAX_EXPORT)))


@router.patch("/{event_id}", status_code=status.HTTP_204_NO_CONTENT)
def label_event(
    event_id: UUID,
    body: LabelUpdate,
    request: Request,
    caller: CurrentCaller,
    settings: SettingsDep,
) -> None:
    store = event_store(request, caller, settings)
    if not _call(lambda: store.label_event(caller.user_id, event_id, body.human_label)):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")


@router.delete("", status_code=status.HTTP_204_NO_CONTENT)
def delete_events(request: Request, caller: CurrentCaller, settings: SettingsDep) -> None:
    """Forgets every kept decision of the caller."""
    store = event_store(request, caller, settings)
    _call(lambda: store.delete_events(caller.user_id))
