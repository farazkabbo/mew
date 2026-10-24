"""Device sign-in for the desktop app (Screen Coach, decision 8).

Who calls what (every route also needs the internal secret: only the Next.js server calls this
API):
- the signed-in owner (Clerk token): get a link code, list devices, revoke them;
- the desktop app, through Next.js, with no user session: redeem a link code for a token,
  check a token, revoke its own token.
"""

import logging
from collections.abc import Callable
from datetime import UTC, datetime
from functools import partial
from uuid import UUID

from fastapi import APIRouter, HTTPException, Request, status

from ..config import Settings
from ..deps import Caller, CurrentCaller, SettingsDep
from ..devices.models import (
    DeviceList,
    ExchangeRequest,
    IssuedToken,
    LinkCode,
    LinkCodeRequest,
    TokenCheck,
    VerifiedDevice,
)
from ..devices.store import (
    SCREEN_SCOPE,
    DeviceRegistry,
    MemoryDeviceStore,
    OwnerDevices,
    SupabaseDeviceRegistry,
    SupabaseOwnerDevices,
)
from ..devices.tokens import (
    LINK_CODE_TTL_S,
    TOKEN_PATTERN,
    LinkCodes,
    LinkGrant,
    hash_token,
    new_device_token,
)
from ..supabase_rest import StoreError

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/devices", tags=["devices"])


# ─── Stores ──────────────────────────────────────────────────────────────────────────────────


def _link_codes(request: Request) -> LinkCodes:
    codes: LinkCodes = request.app.state.link_codes
    return codes


def _local_devices(request: Request) -> MemoryDeviceStore:
    store: MemoryDeviceStore = request.app.state.local_devices
    return store


def _registry(settings: Settings) -> DeviceRegistry:
    """The database side of device tokens; needs the secret key (there's no user session)."""
    if not settings.supabase_url or settings.supabase_secret_key is None:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Device sign-in isn't configured")
    return SupabaseDeviceRegistry(
        settings.supabase_url,
        api_key=settings.supabase_secret_key.get_secret_value(),
        user_token=None,
    )


def _owner_devices(request: Request, caller: Caller, settings: Settings) -> OwnerDevices:
    if caller.is_local:
        return _local_devices(request)
    if not settings.supabase_url or not settings.supabase_publishable_key:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Device sign-in isn't configured")
    return SupabaseOwnerDevices(
        settings.supabase_url, api_key=settings.supabase_publishable_key, user_token=caller.token
    )


def _registries_for_token(request: Request, settings: Settings) -> list[DeviceRegistry]:
    """Where a token may be found: the local-mode store (development only), then the database."""
    registries: list[DeviceRegistry] = []
    if settings.is_development:
        registries.append(_local_devices(request))
    if settings.supabase_url and settings.supabase_secret_key is not None:
        registries.append(_registry(settings))
    return registries


def _call[T](fn: Callable[[], T]) -> T:
    """Maps store failures to safe HTTP errors (details stay in the logs)."""
    try:
        return fn()
    except PermissionError:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Unauthorized") from None
    except StoreError:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, "Device storage unavailable") from None


# ─── The owner (signed in) ───────────────────────────────────────────────────────────────────


@router.post("/link-codes")
def create_link_code(body: LinkCodeRequest, request: Request, caller: CurrentCaller) -> LinkCode:
    """A one-time code the signed-in page hands to the desktop app (valid for a minute)."""
    grant = LinkGrant(user_id=caller.user_id, local=caller.is_local)
    code = _link_codes(request).issue(grant, body.challenge)
    return LinkCode(code=code, expires_in_s=int(LINK_CODE_TTL_S))


@router.get("")
def list_devices(request: Request, caller: CurrentCaller, settings: SettingsDep) -> DeviceList:
    store = _owner_devices(request, caller, settings)
    return DeviceList(devices=_call(lambda: store.list_devices(caller.user_id)))


@router.post("/{device_id}/revoke", status_code=status.HTTP_204_NO_CONTENT)
def revoke_device(
    device_id: UUID, request: Request, caller: CurrentCaller, settings: SettingsDep
) -> None:
    store = _owner_devices(request, caller, settings)
    if not _call(lambda: store.revoke(caller.user_id, device_id)):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")


@router.post("/revoke-all", status_code=status.HTTP_204_NO_CONTENT)
def revoke_all_devices(request: Request, caller: CurrentCaller, settings: SettingsDep) -> None:
    store = _owner_devices(request, caller, settings)
    _call(lambda: store.revoke_all(caller.user_id))


# ─── The desktop app (no user session) ───────────────────────────────────────────────────────


@router.post("/exchange")
def exchange_link_code(
    body: ExchangeRequest, request: Request, settings: SettingsDep
) -> IssuedToken:
    """Redeems a link code with its verifier for a device token (shown only this once)."""
    grant = _link_codes(request).redeem(body.code, body.verifier)
    if grant is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Invalid or expired link code")
    registry: DeviceRegistry = _local_devices(request) if grant.local else _registry(settings)
    token = new_device_token()
    device_id = _call(lambda: registry.add(grant.user_id, hash_token(token), body.device_name))
    logger.info("Linked a device (%s)", device_id)
    return IssuedToken(token=token, device_id=device_id)


def find_device(token: str, request: Request, settings: Settings) -> VerifiedDevice | None:
    """Who an active device token acts for, or None (unknown or revoked). Used by every route
    the desktop app calls, so revoking a device takes effect at once."""
    token_hash = hash_token(token)
    for registry in _registries_for_token(request, settings):
        device = _call(partial(registry.find_active, token_hash))
        if device is None:
            continue
        if device.needs_touch(datetime.now(UTC)):
            try:
                registry.touch(device.id)
            except (PermissionError, StoreError):
                logger.warning("Couldn't note device use (%s)", device.id)
        return VerifiedDevice(
            user_id=device.user_id,
            device_id=device.id,
            scopes=list(device.scopes),
            local=isinstance(registry, MemoryDeviceStore),
        )
    return None


def screen_device(token: str | None, request: Request, settings: Settings) -> VerifiedDevice:
    """The desktop app calling a Screen Coach route: its token (the `X-Mew-Device-Token` header)
    must be active and carry the screen scope (decision 8: device tokens are for Screen Coach
    only). Checked against the database on every request: a user id is never taken from the
    caller."""
    if token is None or not TOKEN_PATTERN.match(token):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Unauthorized")
    device = find_device(token, request, settings)
    if device is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Unauthorized")
    if SCREEN_SCOPE not in device.scopes:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Not allowed")
    return device


@router.post("/verify")
def verify_device_token(
    body: TokenCheck, request: Request, settings: SettingsDep
) -> VerifiedDevice:
    """Who a device token acts for. 401 for unknown or revoked tokens (checked on every
    Screen Coach request, so revoking takes effect at once)."""
    device = find_device(body.token, request, settings)
    if device is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Unauthorized")
    return device


@router.post("/revoke-self", status_code=status.HTTP_204_NO_CONTENT)
def revoke_own_token(body: TokenCheck, request: Request, settings: SettingsDep) -> None:
    """The desktop app signing out: its token stops working everywhere at once."""
    token_hash = hash_token(body.token)
    for registry in _registries_for_token(request, settings):
        _call(partial(registry.revoke_token, token_hash))
