"""The free allowance (docs/LAUNCH_LIMITS.md), for the Next.js server's question gate only.

These routes take the user id from the Next server, which checked the Clerk session or the
device token first; like every /v1 route they need the internal secret, so nothing else can
call them. Local mode (development without Clerk) keeps the count in memory.
"""

from collections.abc import Callable
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, HTTPException, Request, status
from pydantic import BaseModel, ConfigDict, Field, StringConstraints
from pydantic.alias_generators import to_camel

from ..config import Settings
from ..deps import LOCAL_USER_ID, SettingsDep
from ..quota import QuotaExceededError, QuotaStore, SupabaseQuotaStore
from ..supabase_rest import StoreError

router = APIRouter(prefix="/quota", tags=["quota"])

UserId = Annotated[str, StringConstraints(min_length=1, max_length=200, pattern=r"^[A-Za-z0-9_]+$")]
DeviceHash = Annotated[str, StringConstraints(pattern=r"^[0-9a-f]{64}$")]


class _Camel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="forbid")


class ReserveRequest(_Camel):
    user_id: UserId
    device_hash: DeviceHash | None = None
    limit: int = Field(ge=0, le=100_000)
    daily: bool = False
    unlimited: bool = False


class Reserved(_Camel):
    question_id: UUID
    #: Questions the learner has left after this one.
    remaining: int


class FinishRequest(_Camel):
    model: Annotated[str, StringConstraints(max_length=100)] = ""
    input_tokens: int = Field(default=0, ge=0)
    output_tokens: int = Field(default=0, ge=0)


class AllowanceOut(_Camel):
    used: int
    limit: int
    unlimited: bool
    remaining: int


class Done(_Camel):
    changed: bool


def _store(request: Request, settings: Settings, user: str | None) -> QuotaStore:
    if user == LOCAL_USER_ID or (user is None and settings.is_development):
        store: QuotaStore = request.app.state.local_quota
        return store
    if not settings.supabase_url or settings.supabase_secret_key is None:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Quota isn't configured")
    return SupabaseQuotaStore(
        settings.supabase_url,
        api_key=settings.supabase_secret_key.get_secret_value(),
        user_token=None,
    )


def _call[T](work: Callable[[], T]) -> T:
    try:
        return work()
    except StoreError:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, "Quota store failed") from None


@router.post("/reserve")
def reserve(body: ReserveRequest, request: Request, settings: SettingsDep) -> Reserved:
    store = _store(request, settings, body.user_id)
    try:
        question = _call(
            lambda: store.reserve(
                body.user_id, body.device_hash, body.limit, body.daily, body.unlimited
            )
        )
    except QuotaExceededError:
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "QUOTA_EXCEEDED") from None
    left = _call(lambda: store.allowance(body.user_id, body.limit))
    return Reserved(question_id=question, remaining=left.remaining)


class EnsureRequest(_Camel):
    user_id: UserId
    limit: int = Field(ge=0, le=100_000)


@router.post("/ensure", status_code=status.HTTP_204_NO_CONTENT)
def ensure(body: EnsureRequest, request: Request, settings: SettingsDep) -> None:
    """Clerk's user.created webhook: the learner starts with their full allowance."""
    store = _store(request, settings, body.user_id)
    _call(lambda: store.ensure(body.user_id, body.limit))


@router.post("/notify", status_code=status.HTTP_204_NO_CONTENT)
def notify(body: EnsureRequest, request: Request, settings: SettingsDep) -> None:
    """The learner ran out: flag them to be emailed when more questions open up."""
    store = _store(request, settings, body.user_id)
    _call(lambda: store.ask_to_notify(body.user_id, body.limit))


@router.post("/{question_id}/refund")
def refund(question_id: UUID, request: Request, settings: SettingsDep, user: str) -> Done:
    store = _store(request, settings, user)
    return Done(changed=_call(lambda: store.refund(question_id)))


@router.post("/{question_id}/finish")
def finish(
    question_id: UUID, body: FinishRequest, request: Request, settings: SettingsDep, user: str
) -> Done:
    store = _store(request, settings, user)
    return Done(
        changed=_call(
            lambda: store.finish(question_id, body.model, body.input_tokens, body.output_tokens)
        )
    )


@router.get("/allowance")
def allowance(user: UserId, limit: int, request: Request, settings: SettingsDep) -> AllowanceOut:
    store = _store(request, settings, user)
    found = _call(lambda: store.allowance(user, limit))
    return AllowanceOut(
        used=found.used, limit=found.limit, unlimited=found.unlimited, remaining=found.remaining
    )
