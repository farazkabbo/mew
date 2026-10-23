"""Where device tokens live: `device_tokens` in Supabase, or memory in local mode.

Two kinds of access, as the table's grants allow (migration 20261022010000):
- the registry (API service, secret key): adds tokens, finds the device for a token, notes use;
- the owner (user's Clerk token, RLS): lists their devices and revokes them.
"""

import threading
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Protocol
from uuid import UUID

from ..supabase_rest import StoreError, SupabaseRest
from .models import Device

SCREEN_SCOPE = "screen"
LAST_USED_RESOLUTION = timedelta(hours=1)
"""`last_used_at` is refreshed at most this often, so checking a token rarely writes."""


@dataclass(frozen=True, slots=True)
class ActiveDevice:
    id: UUID
    user_id: str
    scopes: tuple[str, ...]
    last_used_at: datetime | None

    def needs_touch(self, now: datetime) -> bool:
        return self.last_used_at is None or now - self.last_used_at >= LAST_USED_RESOLUTION


class DeviceRegistry(Protocol):
    def add(self, user: str, token_hash: str, device_name: str) -> UUID: ...
    def find_active(self, token_hash: str) -> ActiveDevice | None:
        """The device a token belongs to, unless the token is unknown or revoked."""
        ...

    def touch(self, device_id: UUID) -> None: ...
    def revoke_token(self, token_hash: str) -> None: ...


class OwnerDevices(Protocol):
    def list_devices(self, user: str) -> list[Device]:
        """Newest first."""
        ...

    def revoke(self, user: str, device_id: UUID) -> bool: ...
    def revoke_all(self, user: str) -> None: ...


@dataclass(slots=True)
class _Row:
    device: Device
    user_id: str
    token_hash: str


class MemoryDeviceStore:
    """Local mode (development without Clerk): both kinds of access, in memory."""

    def __init__(self) -> None:
        self._rows: list[_Row] = []
        self._lock = threading.Lock()

    def add(self, user: str, token_hash: str, device_name: str) -> UUID:
        device = Device(
            id=uuid.uuid4(),
            device_name=device_name,
            created_at=datetime.now(UTC),
            last_used_at=None,
            revoked_at=None,
        )
        with self._lock:
            self._rows.append(_Row(device, user, token_hash))
        return device.id

    def find_active(self, token_hash: str) -> ActiveDevice | None:
        with self._lock:
            for row in self._rows:
                if row.token_hash == token_hash and row.device.revoked_at is None:
                    return ActiveDevice(
                        row.device.id, row.user_id, (SCREEN_SCOPE,), row.device.last_used_at
                    )
        return None

    def touch(self, device_id: UUID) -> None:
        self._update(lambda row: row.device.id == device_id, last_used_at=datetime.now(UTC))

    def revoke_token(self, token_hash: str) -> None:
        self._update(lambda row: row.token_hash == token_hash, revoked_at=datetime.now(UTC))

    def list_devices(self, user: str) -> list[Device]:
        with self._lock:
            return [row.device for row in reversed(self._rows) if row.user_id == user]

    def revoke(self, user: str, device_id: UUID) -> bool:
        return self._update(
            lambda row: row.user_id == user and row.device.id == device_id,
            revoked_at=datetime.now(UTC),
        )

    def revoke_all(self, user: str) -> None:
        self._update(lambda row: row.user_id == user, revoked_at=datetime.now(UTC))

    def _update(self, matches: Callable[[_Row], bool], **fields: datetime) -> bool:
        """Applies `fields` to matching rows that aren't revoked yet; True if any matched."""
        changed = False
        with self._lock:
            for row in self._rows:
                if matches(row) and row.device.revoked_at is None:
                    row.device = row.device.model_copy(update=fields)
                    changed = True
        return changed


class SupabaseDeviceRegistry(SupabaseRest):
    """The API service's side, with the secret key (bypasses RLS). Every write names the user
    or the token hash explicitly."""

    def add(self, user: str, token_hash: str, device_name: str) -> UUID:
        # The token references the user's profile, which may not exist yet for a new account.
        self._request(
            "POST",
            "/rest/v1/profiles",
            json=[{"id": user}],
            headers={"Prefer": "resolution=ignore-duplicates,return=minimal"},
        )
        rows = self._insert(
            "device_tokens",
            [{"user_id": user, "token_hash": token_hash, "device_name": device_name}],
            select="id",
        )
        if not rows:
            raise StoreError("device token was not stored")
        return UUID(str(rows[0]["id"]))

    def find_active(self, token_hash: str) -> ActiveDevice | None:
        rows = self._get(
            "device_tokens",
            {
                "token_hash": f"eq.{token_hash}",
                "revoked_at": "is.null",
                "select": "id,user_id,scopes,last_used_at",
                "limit": "1",
            },
        )
        if not rows:
            return None
        row = rows[0]
        last_used = row.get("last_used_at")
        return ActiveDevice(
            id=UUID(str(row["id"])),
            user_id=str(row["user_id"]),
            scopes=tuple(str(scope) for scope in row.get("scopes") or ()),
            last_used_at=datetime.fromisoformat(last_used) if last_used else None,
        )

    def touch(self, device_id: UUID) -> None:
        self._patch("device_tokens", {"id": f"eq.{device_id}"}, {"last_used_at": datetime.now(UTC)})

    def revoke_token(self, token_hash: str) -> None:
        self._patch(
            "device_tokens",
            {"token_hash": f"eq.{token_hash}", "revoked_at": "is.null"},
            {"revoked_at": datetime.now(UTC)},
        )


class SupabaseOwnerDevices(SupabaseRest):
    """The owner's side, with their Clerk token (RLS: own rows; only `revoked_at` writable)."""

    _SELECT = "id,device_name,created_at,last_used_at,revoked_at"

    def list_devices(self, user: str) -> list[Device]:
        rows = self._get(
            "device_tokens",
            {"user_id": f"eq.{user}", "select": self._SELECT, "order": "created_at.desc"},
        )
        return [Device.model_validate(row) for row in rows]

    def revoke(self, user: str, device_id: UUID) -> bool:
        rows = self._patch(
            "device_tokens",
            {"user_id": f"eq.{user}", "id": f"eq.{device_id}", "revoked_at": "is.null"},
            {"revoked_at": datetime.now(UTC)},
        )
        return bool(rows)

    def revoke_all(self, user: str) -> None:
        self._patch(
            "device_tokens",
            {"user_id": f"eq.{user}", "revoked_at": "is.null"},
            {"revoked_at": datetime.now(UTC)},
        )
