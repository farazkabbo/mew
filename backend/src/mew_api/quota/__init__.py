"""The free allowance (docs/LAUNCH_LIMITS.md): reserve, refund and finish a question.

The count lives in Postgres (`question_quota`, `device_quota`, `question_log`), written only
through the migration's functions with the secret key. Local mode keeps the same rules in memory.
"""

import threading
from dataclasses import dataclass, field
from datetime import UTC, date, datetime
from typing import Protocol
from uuid import UUID, uuid4

from ..supabase_rest import StoreError, SupabaseRest


class QuotaExceededError(Exception):
    """The learner's or the computer's allowance is used up."""


@dataclass(frozen=True, slots=True)
class Allowance:
    used: int
    limit: int
    unlimited: bool

    @property
    def remaining(self) -> int:
        return max(self.limit - self.used, 0)


class QuotaStore(Protocol):
    def reserve(
        self, user: str, device: str | None, limit: int, daily: bool, unlimited: bool
    ) -> UUID:
        """Counts one question; raises QuotaExceededError (counting nothing) when it is used up."""
        ...

    def refund(self, question: UUID) -> bool: ...
    def finish(self, question: UUID, model: str, input_tokens: int, output_tokens: int) -> bool: ...
    def allowance(self, user: str, limit: int) -> Allowance: ...
    def ensure(self, user: str, limit: int) -> None:
        """Creates the learner's row (0 used) if it isn't there yet."""
        ...


@dataclass(slots=True)
class _Count:
    used: int = 0
    day: date = field(default_factory=lambda: datetime.now(UTC).date())


class MemoryQuotaStore:
    """Local mode: the same rules, in this process."""

    def __init__(self) -> None:
        self._users: dict[str, tuple[_Count, int, bool]] = {}
        self._devices: dict[str, _Count] = {}
        self._log: dict[UUID, tuple[str, str | None, str]] = {}
        self._lock = threading.Lock()

    @staticmethod
    def _take(count: _Count, limit: int, daily: bool, unlimited: bool) -> bool:
        today = datetime.now(UTC).date()
        if daily and count.day < today:
            count.used, count.day = 0, today
        if not unlimited and count.used >= limit:
            return False
        count.used += 1
        return True

    def reserve(
        self, user: str, device: str | None, limit: int, daily: bool, unlimited: bool
    ) -> UUID:
        with self._lock:
            count, user_limit, _ = self._users.get(user, (_Count(), limit, unlimited))
            device_count = self._devices.get(device, _Count()) if device else None
            before = (count.used, count.day, device_count.used if device_count else 0)
            if not self._take(count, user_limit, daily, unlimited):
                raise QuotaExceededError
            if device_count is not None and not unlimited:
                if not self._take(device_count, limit, daily, False):
                    count.used, count.day = before[0], before[1]
                    raise QuotaExceededError
                self._devices[device or ""] = device_count
            self._users[user] = (count, user_limit, unlimited)
            question = uuid4()
            self._log[question] = (user, device if not unlimited else None, "reserved")
            return question

    def refund(self, question: UUID) -> bool:
        with self._lock:
            entry = self._log.get(question)
            if entry is None or entry[2] != "reserved":
                return False
            user, device, _ = entry
            self._log[question] = (user, device, "refunded")
            count = self._users[user][0]
            count.used = max(count.used - 1, 0)
            if device and device in self._devices:
                self._devices[device].used = max(self._devices[device].used - 1, 0)
            return True

    def finish(self, question: UUID, model: str, input_tokens: int, output_tokens: int) -> bool:
        with self._lock:
            entry = self._log.get(question)
            if entry is None or entry[2] != "reserved":
                return False
            self._log[question] = (entry[0], entry[1], "done")
            return True

    def ensure(self, user: str, limit: int) -> None:
        with self._lock:
            self._users.setdefault(user, (_Count(), limit, False))

    def allowance(self, user: str, limit: int) -> Allowance:
        with self._lock:
            count, user_limit, unlimited = self._users.get(user, (_Count(), limit, False))
            return Allowance(count.used, user_limit, unlimited)


class SupabaseQuotaStore(SupabaseRest):
    """The migration's functions, with the secret key (only the API service holds it)."""

    def reserve(
        self, user: str, device: str | None, limit: int, daily: bool, unlimited: bool
    ) -> UUID:
        response = self.http.post(
            f"{self.base}/rest/v1/rpc/reserve_question",
            headers=self.headers,
            json={
                "p_user": user,
                "p_device": device,
                "p_limit": limit,
                "p_daily": daily,
                "p_unlimited": unlimited,
            },
        )
        if response.status_code >= 400 and "QUOTA_EXCEEDED" in response.text:
            raise QuotaExceededError
        if response.status_code >= 400:
            raise StoreError(f"reserve failed ({response.status_code})")
        return UUID(str(response.json()))

    def refund(self, question: UUID) -> bool:
        return bool(
            self._request(
                "POST", "/rest/v1/rpc/refund_question", json={"p_id": str(question)}
            ).json()
        )

    def finish(self, question: UUID, model: str, input_tokens: int, output_tokens: int) -> bool:
        return bool(
            self._request(
                "POST",
                "/rest/v1/rpc/finish_question",
                json={
                    "p_id": str(question),
                    "p_model": model,
                    "p_input_tokens": input_tokens,
                    "p_output_tokens": output_tokens,
                },
            ).json()
        )

    def ensure(self, user: str, limit: int) -> None:
        self._request(
            "POST",
            "/rest/v1/question_quota",
            json={"user_id": user, "limit_total": limit},
            headers={"Prefer": "resolution=ignore-duplicates,return=minimal"},
        )

    def allowance(self, user: str, limit: int) -> Allowance:
        rows = self._get(
            "question_quota", {"user_id": f"eq.{user}", "select": "used,limit_total,unlimited"}
        )
        if not rows:
            return Allowance(0, limit, False)
        row = rows[0]
        return Allowance(int(row["used"]), int(row["limit_total"]), bool(row["unlimited"]))
