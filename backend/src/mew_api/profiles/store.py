"""Where settings live: profiles.settings in Supabase (RLS-scoped), or memory in local mode."""

import threading
from typing import Any, Protocol

from ..supabase_rest import SupabaseRest
from .models import UserSettings


class ProfileStore(Protocol):
    def get_settings(self, user: str) -> UserSettings: ...
    def update_settings(self, user: str, changes: dict[str, Any]) -> UserSettings:
        """Merges `changes` into the stored settings and returns the result."""
        ...


class MemoryProfileStore:
    """Local mode: settings kept in this process (like the local course store)."""

    def __init__(self) -> None:
        self._settings: dict[str, dict[str, Any]] = {}
        self._lock = threading.Lock()

    def get_settings(self, user: str) -> UserSettings:
        with self._lock:
            return UserSettings.model_validate(self._settings.get(user, {}))

    def update_settings(self, user: str, changes: dict[str, Any]) -> UserSettings:
        with self._lock:
            merged = {**self._settings.get(user, {}), **changes}
            settings = UserSettings.model_validate(merged)
            self._settings[user] = merged
            return settings


class SupabaseProfileStore(SupabaseRest):
    """profiles.settings through PostgREST with the user's token: RLS limits it to their row."""

    def get_settings(self, user: str) -> UserSettings:
        rows = self._get("profiles", {"id": f"eq.{user}", "select": "settings"})
        stored = rows[0].get("settings") if rows else None
        return UserSettings.model_validate(stored if isinstance(stored, dict) else {})

    def update_settings(self, user: str, changes: dict[str, Any]) -> UserSettings:
        self._request(
            "POST",
            "/rest/v1/profiles",
            json={"id": user},
            headers={"Prefer": "resolution=ignore-duplicates,return=minimal"},
        )
        rows = self._get("profiles", {"id": f"eq.{user}", "select": "settings"})
        current = rows[0].get("settings") if rows else None
        merged = {**(current if isinstance(current, dict) else {}), **changes}
        settings = UserSettings.model_validate(merged)
        self._patch("profiles", {"id": f"eq.{user}"}, {"settings": merged})
        return settings
