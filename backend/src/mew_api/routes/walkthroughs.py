"""Coach-mode walkthroughs (Screen Coach S4, docs/SCREEN_COACH.md decision 10).

The desktop app calls these through the web app's server, with its device token, which is
checked here again (a user id is never taken from the caller). The web app's server runs the
state machine and sends the result; this service checks it and stores it:
- the plan can't change once the walkthrough has started (only its progress can);
- a finished walkthrough can't change at all;
- every update names the revision it was computed from, so two events can't race.
"""

import logging
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Header, HTTPException, Request, status

from ..config import Settings
from ..deps import SettingsDep
from ..devices.models import VerifiedDevice
from ..supabase_rest import StoreError
from ..walkthroughs.models import WalkthroughCreate, WalkthroughUpdate, WalkthroughView
from ..walkthroughs.store import (
    MemoryWalkthroughStore,
    SupabaseWalkthroughStore,
    WalkthroughStore,
)
from .devices import screen_device

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/walkthroughs/device", tags=["walkthroughs"])

#: "Continue where we left off" picks up walkthroughs touched this recently.
RESUME_WITHIN = timedelta(days=7)

DeviceToken = Annotated[str | None, Header(alias="X-Mew-Device-Token")]


def _store(request: Request, settings: Settings, device: VerifiedDevice) -> WalkthroughStore:
    if device.local:
        local: MemoryWalkthroughStore = request.app.state.local_walkthroughs
        return local
    if not settings.supabase_url or settings.supabase_secret_key is None:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Walkthroughs aren't configured")
    return SupabaseWalkthroughStore(
        settings.supabase_url,
        api_key=settings.supabase_secret_key.get_secret_value(),
        user_token=None,
    )


def _call[T](fn: Callable[[], T]) -> T:
    """Maps store failures to safe HTTP errors (details stay in the logs)."""
    try:
        return fn()
    except PermissionError:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Unauthorized") from None
    except StoreError:
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY, "Walkthrough storage unavailable"
        ) from None


def _not_found() -> HTTPException:
    return HTTPException(status.HTTP_404_NOT_FOUND, "Not found")


def _conflict() -> HTTPException:
    return HTTPException(status.HTTP_409_CONFLICT, "The walkthrough has moved on")


@router.post("", status_code=status.HTTP_201_CREATED)
def create_walkthrough(
    body: WalkthroughCreate, request: Request, settings: SettingsDep, token: DeviceToken = None
) -> WalkthroughView:
    device = screen_device(token, request, settings)
    store = _store(request, settings, device)
    created = _call(lambda: store.create(device.user_id, body))
    # Ids and counts only: never the goal or the steps.
    logger.info("Started a walkthrough (%s, %d steps)", created.id, len(created.steps))
    return created


@router.get("/latest")
def latest_walkthrough(
    request: Request, settings: SettingsDep, token: DeviceToken = None
) -> WalkthroughView:
    """The walkthrough to continue, if one was left unfinished in the last 7 days."""
    device = screen_device(token, request, settings)
    store = _store(request, settings, device)
    since = datetime.now(UTC) - RESUME_WITHIN
    latest = _call(lambda: store.latest_resumable(device.user_id, since))
    if latest is None:
        raise _not_found()
    return latest


@router.get("/{walkthrough_id}")
def get_walkthrough(
    walkthrough_id: UUID, request: Request, settings: SettingsDep, token: DeviceToken = None
) -> WalkthroughView:
    device = screen_device(token, request, settings)
    store = _store(request, settings, device)
    found = _call(lambda: store.get(device.user_id, walkthrough_id))
    if found is None:
        raise _not_found()
    return found


@router.put("/{walkthrough_id}")
def update_walkthrough(
    walkthrough_id: UUID,
    body: WalkthroughUpdate,
    request: Request,
    settings: SettingsDep,
    token: DeviceToken = None,
) -> WalkthroughView:
    """Writes one event's progress: 409 if the walkthrough changed since it was read (or is
    finished), 400 if the update would change the plan."""
    device = screen_device(token, request, settings)
    store = _store(request, settings, device)
    current = _call(lambda: store.get(device.user_id, walkthrough_id))
    if current is None:
        raise _not_found()
    if current.status == "completed" or current.revision != body.revision:
        raise _conflict()
    if [step.plan() for step in body.steps] != [step.plan() for step in current.steps]:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "The plan can't change")
    updated = _call(lambda: store.update(device.user_id, walkthrough_id, body))
    if updated is None:
        raise _conflict()
    return updated
