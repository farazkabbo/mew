"""Billing data access: subscriptions and usage sessions."""

import threading
from datetime import datetime, timedelta, timezone
from typing import Protocol

from ..supabase_rest import SupabaseRest
from .models import Subscription, UsageSession


class BillingStore(Protocol):
    """Protocol for billing data operations."""

    def get_subscription(self, user: str) -> Subscription | None: ...
    def create_subscription(self, sub: Subscription) -> Subscription: ...
    def update_subscription(self, user: str, **fields: object) -> Subscription | None: ...
    def get_usage_session(self, user: str) -> UsageSession: ...
    def update_usage_session(self, user: str, **fields: object) -> UsageSession: ...
    def reset_usage_session(self, user: str) -> UsageSession: ...


class MemoryBillingStore:
    """Local mode: billing data kept in memory."""

    def __init__(self) -> None:
        self._subscriptions: dict[str, Subscription] = {}
        self._sessions: dict[str, UsageSession] = {}
        self._lock = threading.Lock()

    def get_subscription(self, user: str) -> Subscription | None:
        with self._lock:
            return self._subscriptions.get(user)

    def create_subscription(self, sub: Subscription) -> Subscription:
        with self._lock:
            self._subscriptions[sub.user_id] = sub
            return sub

    def update_subscription(self, user: str, **fields: object) -> Subscription | None:
        with self._lock:
            sub = self._subscriptions.get(user)
            if not sub:
                return None
            updated = sub.model_copy(update={**fields, "updated_at": datetime.now(timezone.utc)})
            self._subscriptions[user] = updated
            return updated

    def get_usage_session(self, user: str) -> UsageSession:
        with self._lock:
            if user not in self._sessions:
                now = datetime.now(timezone.utc)
                self._sessions[user] = UsageSession(
                    user_id=user,
                    seconds_used=0,
                    in_cooldown=False,
                    cooldown_started_at=None,
                    cooldown_ends_at=None,
                    session_started_at=now,
                    last_activity_at=now,
                )
            return self._sessions[user]

    def update_usage_session(self, user: str, **fields: object) -> UsageSession:
        with self._lock:
            session = self.get_usage_session(user)
            updated = session.model_copy(update=fields)
            self._sessions[user] = updated
            return updated

    def reset_usage_session(self, user: str) -> UsageSession:
        with self._lock:
            now = datetime.now(timezone.utc)
            session = UsageSession(
                user_id=user,
                seconds_used=0,
                in_cooldown=False,
                cooldown_started_at=None,
                cooldown_ends_at=None,
                session_started_at=now,
                last_activity_at=now,
            )
            self._sessions[user] = session
            return session


class SupabaseBillingStore(SupabaseRest):
    """Supabase: billing data with RLS (or service role for webhooks)."""

    def get_subscription(self, user: str) -> Subscription | None:
        rows = self._get("subscriptions", {"user_id": f"eq.{user}"})
        if not rows:
            return None
        return Subscription.model_validate(rows[0])

    def create_subscription(self, sub: Subscription) -> Subscription:
        row = self._post("subscriptions", sub.model_dump(mode="json", exclude={"created_at", "updated_at"}))
        return Subscription.model_validate(row[0])

    def update_subscription(self, user: str, **fields: object) -> Subscription | None:
        # Remove None values and non-updatable fields
        updates = {k: v for k, v in fields.items() if v is not None and k not in {"user_id", "created_at"}}
        if not updates:
            return self.get_subscription(user)
        
        rows = self._patch("subscriptions", {"user_id": f"eq.{user}"}, updates)
        if not rows:
            return None
        return Subscription.model_validate(rows[0])

    def get_usage_session(self, user: str) -> UsageSession:
        """Get or create usage session via database function."""
        # Use the database function that creates if not exists
        result = self._request(
            "POST",
            "/rest/v1/rpc/get_or_create_usage_session",
            json={"user_id_param": user}
        )
        return UsageSession.model_validate(result.json())

    def update_usage_session(self, user: str, **fields: object) -> UsageSession:
        # Always ensure session exists first
        self.get_usage_session(user)
        
        updates = {k: v for k, v in fields.items() if k != "user_id"}
        rows = self._patch("usage_sessions", {"user_id": f"eq.{user}"}, updates)
        return UsageSession.model_validate(rows[0])

    def reset_usage_session(self, user: str) -> UsageSession:
        now = datetime.now(timezone.utc)
        return self.update_usage_session(
            user,
            seconds_used=0,
            in_cooldown=False,
            cooldown_started_at=None,
            cooldown_ends_at=None,
            session_started_at=now,
            last_activity_at=now,
        )

