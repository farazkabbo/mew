"""The caller's settings (M9): read them, or change some of them."""

from fastapi import APIRouter, HTTPException, Request, status

from ..config import Settings
from ..deps import Caller, CurrentCaller, SettingsDep
from ..profiles.models import SettingsPatch, UserSettings
from ..profiles.store import ProfileStore, SupabaseProfileStore
from .courses import _call

router = APIRouter(prefix="/me/settings", tags=["settings"])


def profile_store(request: Request, caller: Caller, settings: Settings) -> ProfileStore:
    """The caller's profile: RLS-scoped Supabase when signed in, memory in local mode."""
    if caller.is_local:
        store: ProfileStore = request.app.state.local_profiles
        return store
    if not settings.supabase_url or not settings.supabase_publishable_key:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Settings aren't configured")
    return SupabaseProfileStore(
        settings.supabase_url, api_key=settings.supabase_publishable_key, user_token=caller.token
    )


@router.get("")
def get_settings(request: Request, caller: CurrentCaller, settings: SettingsDep) -> UserSettings:
    store = profile_store(request, caller, settings)
    return _call(lambda: store.get_settings(caller.user_id))


@router.patch("")
def update_settings(
    body: SettingsPatch, request: Request, caller: CurrentCaller, settings: SettingsDep
) -> UserSettings:
    store = profile_store(request, caller, settings)
    changes = body.model_dump(exclude_unset=True)
    return _call(lambda: store.update_settings(caller.user_id, changes))
