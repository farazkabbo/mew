"""Handoff (docs/HANDOFF_FEATURE.md, being built).

Who calls what (every route also needs the internal secret: only the Next.js server calls this
API):
- the sender's desktop app, with its device token: create a handoff, upload its ciphertext,
  finalize it, revoke it; open one it received (Pick up from here);
- signed-in members (Clerk token, plus the verified email Next.js read from Clerk, which is how
  an invited recipient is matched on their first open): read it and its ciphertext, record what
  they did, reply; the sender also sees who opened it, and can revoke it;
- the daily job: purge expired and revoked handoffs.

Expired or revoked: 410 on every request. Not a member: 403. Nothing here logs titles, replies or
emails: ids, counts and sizes only.
"""

import logging
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from typing import Annotated, Literal
from uuid import UUID, uuid4

from fastapi import APIRouter, Header, HTTPException, Request, Response, status

from ..config import Settings
from ..deps import CurrentCaller, SettingsDep
from ..handoffs.models import (
    MAX_PACKAGE_BYTES,
    Event,
    EventIn,
    HandoffCreate,
    HandoffCreated,
    HandoffView,
    Inbox,
    InboxItem,
    InboxStatus,
    Member,
    People,
    Purged,
    Reply,
    ReplyIn,
    Teaser,
)
from ..handoffs.store import HandoffStore, MemoryHandoffStore, Row, SupabaseHandoffStore
from ..handoffs.store import storage_path as path_for
from ..supabase_rest import StoreError
from .devices import screen_device

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/handoffs", tags=["handoffs"])

Role = Literal["sender", "recipient"]


def _now() -> datetime:
    return datetime.now(UTC)


def _store(request: Request, settings: Settings, local: bool) -> HandoffStore:
    # Tests share one store between several signed-in users.
    shared: HandoffStore | None = getattr(request.app.state, "handoff_store_override", None)
    if shared is not None:
        return shared
    if local:
        store: MemoryHandoffStore = request.app.state.local_handoffs
        return store
    if not settings.supabase_url or settings.supabase_secret_key is None:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Handoff isn't configured")
    return SupabaseHandoffStore(
        settings.supabase_url,
        api_key=settings.supabase_secret_key.get_secret_value(),
        user_token=None,
    )


def _email(header: str | None) -> str | None:
    value = (header or "").strip().lower()
    return value if "@" in value and len(value) <= 254 else None


class Who:
    """The caller: a user id, their verified email (if known) and which store holds their data."""

    def __init__(self, user: str, email: str | None, store: HandoffStore) -> None:
        self.user, self.email, self.store = user, email, store


def _device(request: Request, settings: Settings, token: str | None, email: str | None) -> Who:
    device = screen_device(token, request, settings)
    return Who(device.user_id, _email(email), _store(request, settings, device.local))


def _user(request: Request, settings: Settings, caller: CurrentCaller, email: str | None) -> Who:
    return Who(caller.user_id, _email(email), _store(request, settings, caller.is_local))


def _gone() -> HTTPException:
    return HTTPException(status.HTTP_410_GONE, "This handoff has expired or was revoked")


def _live(row: Row | None) -> Row:
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    if row["status"] == "revoked" or row["expires_at"] <= _now():
        raise _gone()
    return row


def _access(who: Who, handoff_id: UUID) -> tuple[Row, Role]:
    """The handoff and the caller's role in it, or 404 / 410 / 403. An invited recipient opening
    it for the first time is matched by their verified email and bound to their id."""
    row = _live(who.store.handoff(handoff_id))
    if row["sender_id"] == who.user:
        return row, "sender"
    for member in who.store.members(handoff_id):
        by_id = member.get("user_id") == who.user
        by_email = who.email is not None and member["email"] == who.email
        if by_id or by_email:
            if row["status"] != "sent":
                break
            if member.get("user_id") is None:
                who.store.update_member(handoff_id, member["email"], {"user_id": who.user})
            return row, "recipient"
    raise HTTPException(status.HTTP_403_FORBIDDEN, "This handoff wasn't shared with you")


def _call[T](fn: Callable[[], T]) -> T:
    try:
        return fn()
    except PermissionError:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, "Handoff storage refused") from None
    except StoreError:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, "Handoff storage unavailable") from None


# ─── The sender's desktop app ────────────────────────────────────────────────────────────────


@router.post("", status_code=status.HTTP_201_CREATED)
def create_handoff(
    body: HandoffCreate,
    request: Request,
    settings: SettingsDep,
    x_mew_device_token: Annotated[str | None, Header()] = None,
) -> HandoffCreated:
    """A draft: its row and members. The ciphertext comes next, then `finalize` sends it."""
    who = _device(request, settings, x_mew_device_token, None)
    handoff_id = uuid4()
    now = _now()
    row: Row = {
        "id": handoff_id,
        "sender_id": who.user,
        "sender_name": body.sender_name.strip(),
        "title": body.title.strip(),
        "status": "draft",
        "expires_at": now + timedelta(days=body.expires_in_days),
        "revoked_at": None,
        "created_at": now,
        "storage_path": path_for(who.user, handoff_id),
        "wrapped_key": body.wrapped_key,
        "size_bytes": body.size_bytes,
    }
    emails = sorted({r.email for r in body.recipients})
    members = [
        {"handoff_id": handoff_id, "user_id": None, "email": e, "role": "recipient"} for e in emails
    ]
    _call(lambda: who.store.insert_handoff(row, members))
    logger.info("Handoff drafted (%s, %d recipients)", handoff_id, len(emails))
    return HandoffCreated(id=handoff_id)


@router.put("/{handoff_id}/package", status_code=status.HTTP_204_NO_CONTENT)
async def upload_package(
    handoff_id: UUID,
    request: Request,
    settings: SettingsDep,
    x_mew_device_token: Annotated[str | None, Header()] = None,
) -> Response:
    """The ciphertext (a draft's, from its sender; never larger than it said)."""
    who = _device(request, settings, x_mew_device_token, None)
    row = _live(who.store.handoff(handoff_id))
    if row["sender_id"] != who.user or row["status"] != "draft":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Not allowed")
    data = await request.body()
    if not data or len(data) > min(row["size_bytes"], MAX_PACKAGE_BYTES):
        raise HTTPException(status.HTTP_413_CONTENT_TOO_LARGE, "The package is too large")
    _call(lambda: who.store.put_object(row["storage_path"], data))
    logger.info("Handoff package stored (%s, %d KB)", handoff_id, len(data) // 1024)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/{handoff_id}/finalize", status_code=status.HTTP_204_NO_CONTENT)
def finalize(
    handoff_id: UUID,
    request: Request,
    settings: SettingsDep,
    x_mew_device_token: Annotated[str | None, Header()] = None,
) -> Response:
    who = _device(request, settings, x_mew_device_token, None)
    row = _live(who.store.handoff(handoff_id))
    if row["sender_id"] != who.user or row["status"] != "draft":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Not allowed")
    if _call(lambda: who.store.get_object(row["storage_path"])) is None:
        raise HTTPException(status.HTTP_409_CONFLICT, "The package hasn't been uploaded")
    _call(lambda: who.store.update_handoff(handoff_id, {"status": "sent"}))
    _call(lambda: who.store.add_event(handoff_id, who.user, "created", _now()))
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/{handoff_id}/device/view")
def view_from_device(
    handoff_id: UUID,
    request: Request,
    settings: SettingsDep,
    x_mew_device_token: Annotated[str | None, Header()] = None,
    x_mew_user_email: Annotated[str | None, Header()] = None,
) -> HandoffView:
    """Pick up from here: the desktop app reads a handoff it received."""
    who = _device(request, settings, x_mew_device_token, x_mew_user_email)
    return _view(who, handoff_id)


@router.post("/{handoff_id}/device/package")
def package_from_device(
    handoff_id: UUID,
    request: Request,
    settings: SettingsDep,
    x_mew_device_token: Annotated[str | None, Header()] = None,
    x_mew_user_email: Annotated[str | None, Header()] = None,
) -> Response:
    who = _device(request, settings, x_mew_device_token, x_mew_user_email)
    return _package(who, handoff_id)


@router.post("/{handoff_id}/device/events", status_code=status.HTTP_204_NO_CONTENT)
def event_from_device(
    handoff_id: UUID,
    body: EventIn,
    request: Request,
    settings: SettingsDep,
    x_mew_device_token: Annotated[str | None, Header()] = None,
    x_mew_user_email: Annotated[str | None, Header()] = None,
) -> Response:
    who = _device(request, settings, x_mew_device_token, x_mew_user_email)
    _record(who, handoff_id, body.type)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/{handoff_id}/device/revoke", status_code=status.HTTP_204_NO_CONTENT)
def revoke_from_device(
    handoff_id: UUID,
    request: Request,
    settings: SettingsDep,
    x_mew_device_token: Annotated[str | None, Header()] = None,
) -> Response:
    who = _device(request, settings, x_mew_device_token, None)
    _revoke(who, handoff_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ─── Signed-in members ───────────────────────────────────────────────────────────────────────


@router.get("/{handoff_id}/teaser")
def teaser(handoff_id: UUID, request: Request, settings: SettingsDep) -> Teaser:
    """What a link shows before sign-in: whose handoff it is, by first name, and nothing else."""
    local = settings.is_development and request.headers.get("X-Mew-Local-User") == "local"
    store = _store(request, settings, local)
    row = _live(_call(lambda: store.handoff(handoff_id)))
    if row["status"] != "sent":
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    first = row["sender_name"].split()[0][:40] if row["sender_name"].split() else "someone"
    return Teaser(sender_first_name=first)


@router.get("/{handoff_id}")
def view(
    handoff_id: UUID,
    request: Request,
    settings: SettingsDep,
    caller: CurrentCaller,
    x_mew_user_email: Annotated[str | None, Header()] = None,
) -> HandoffView:
    return _view(_user(request, settings, caller, x_mew_user_email), handoff_id)


@router.get("/{handoff_id}/package")
def package(
    handoff_id: UUID,
    request: Request,
    settings: SettingsDep,
    caller: CurrentCaller,
    x_mew_user_email: Annotated[str | None, Header()] = None,
) -> Response:
    return _package(_user(request, settings, caller, x_mew_user_email), handoff_id)


@router.post("/{handoff_id}/events", status_code=status.HTTP_204_NO_CONTENT)
def event(
    handoff_id: UUID,
    body: EventIn,
    request: Request,
    settings: SettingsDep,
    caller: CurrentCaller,
    x_mew_user_email: Annotated[str | None, Header()] = None,
) -> Response:
    _record(_user(request, settings, caller, x_mew_user_email), handoff_id, body.type)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/{handoff_id}/replies", status_code=status.HTTP_201_CREATED)
def reply(
    handoff_id: UUID,
    body: ReplyIn,
    request: Request,
    settings: SettingsDep,
    caller: CurrentCaller,
    x_mew_user_email: Annotated[str | None, Header()] = None,
) -> Reply:
    who = _user(request, settings, caller, x_mew_user_email)
    _access(who, handoff_id)
    now = _now()
    row = {
        "id": uuid4(),
        "handoff_id": handoff_id,
        "author_id": who.user,
        "author_name": body.author_name.strip(),
        "body": body.body.strip(),
        "voice_path": None,
        "created_at": now,
    }
    _call(lambda: who.store.add_reply(row))
    _call(lambda: who.store.add_event(handoff_id, who.user, "replied", now))
    return Reply(
        id=row["id"], author_name=row["author_name"], body=row["body"], created_at=now, mine=True
    )


@router.post("/{handoff_id}/revoke", status_code=status.HTTP_204_NO_CONTENT)
def revoke(
    handoff_id: UUID, request: Request, settings: SettingsDep, caller: CurrentCaller
) -> Response:
    _revoke(_user(request, settings, caller, None), handoff_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("")
def inbox(
    request: Request,
    settings: SettingsDep,
    caller: CurrentCaller,
    x_mew_user_email: Annotated[str | None, Header()] = None,
) -> Inbox:
    """Handoffs received and sent, newest first, with where each one is at."""
    who = _user(request, settings, caller, x_mew_user_email)
    now = _now()
    items: list[InboxItem] = []
    for row in _call(lambda: who.store.sent_by(who.user)):
        members = who.store.members(row["id"])
        items.append(_item(who, row, "sender", members, now))
    seen = {item.id for item in items}
    for member in _call(lambda: who.store.memberships(who.user, who.email)):
        received = who.store.handoff(member["handoff_id"])
        if received is None or received["id"] in seen or received["status"] == "draft":
            continue
        items.append(_item(who, received, "recipient", [member], now))
    items.sort(key=lambda i: i.created_at, reverse=True)
    return Inbox(items=items[:200])


@router.get("/people/recent")
def people(
    request: Request,
    settings: SettingsDep,
    caller: CurrentCaller,
    x_mew_user_email: Annotated[str | None, Header()] = None,
) -> People:
    """The recipient picker's suggestions: people the user handed off to."""
    who = _user(request, settings, caller, x_mew_user_email)
    emails: list[str] = []
    for row in _call(lambda: who.store.sent_by(who.user)):
        for m in who.store.members(row["id"]):
            if m["email"] not in emails:
                emails.append(m["email"])
    return People(emails=emails[:20])


@router.delete("", status_code=status.HTTP_204_NO_CONTENT)
def delete_history(
    request: Request,
    settings: SettingsDep,
    caller: CurrentCaller,
    x_mew_user_email: Annotated[str | None, Header()] = None,
) -> Response:
    """ "Delete my handoff history": everything sent (packages, keys, replies, events) is
    deleted, and the user is taken off everything they received."""
    who = _user(request, settings, caller, x_mew_user_email)
    sent = _call(lambda: who.store.sent_by(who.user))
    _call(lambda: who.store.delete_objects([r["storage_path"] for r in sent]))
    try:
        for row in sent:
            who.store.delete_handoff(row["id"])
        for member in who.store.memberships(who.user, who.email):
            who.store.remove_member(member["handoff_id"], member["email"])
    except (PermissionError, StoreError):
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, "Handoff storage unavailable") from None
    logger.info("Handoff history deleted (%d sent)", len(sent))
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/maintenance/purge")
def purge(request: Request, settings: SettingsDep) -> Purged:
    """The daily job: expired and revoked handoffs, with everything they hold, are deleted."""
    local = settings.is_development and request.headers.get("X-Mew-Local-User") == "local"
    store = _store(request, settings, local)
    paths = _call(lambda: store.purge(_now()))
    _call(lambda: store.delete_objects(paths))
    logger.info("Handoffs purged: %d", len(paths))
    return Purged(count=len(paths))


# ─── Shared ──────────────────────────────────────────────────────────────────────────────────


def _view(who: Who, handoff_id: UUID) -> HandoffView:
    row, role = _call(lambda: _access(who, handoff_id))
    replies = [
        Reply(
            id=r["id"],
            author_name=r["author_name"],
            body=r["body"],
            created_at=r["created_at"],
            mine=r["author_id"] == who.user,
        )
        for r in who.store.replies(handoff_id)
    ]
    view = HandoffView(
        id=row["id"],
        title=row["title"],
        sender_name=row["sender_name"],
        role=role,
        status=row["status"],
        expires_at=row["expires_at"],
        created_at=row["created_at"],
        size_bytes=row["size_bytes"],
        wrapped_key=row["wrapped_key"] or "",
        replies=replies,
    )
    if role == "sender":
        view.members = [
            Member(
                email=m["email"], opened_at=m.get("opened_at"), picked_up_at=m.get("picked_up_at")
            )
            for m in who.store.members(handoff_id)
        ]
        view.events = [Event(type=e["type"], at=e["at"]) for e in who.store.events(handoff_id)]
    return view


def _package(who: Who, handoff_id: UUID) -> Response:
    row, _ = _call(lambda: _access(who, handoff_id))
    data = _call(lambda: who.store.get_object(row["storage_path"]))
    if data is None:
        raise _gone()
    return Response(content=data, media_type="application/octet-stream")


def _record(who: Who, handoff_id: UUID, kind: str) -> None:
    row, role = _call(lambda: _access(who, handoff_id))
    now = _now()
    if role == "recipient":
        member = next(
            (m for m in who.store.members(handoff_id) if m.get("user_id") == who.user), None
        )
        if member and kind == "opened" and member.get("opened_at") is None:
            who.store.update_member(handoff_id, member["email"], {"opened_at": now})
        if member and kind == "picked_up":
            who.store.update_member(handoff_id, member["email"], {"picked_up_at": now})
    _call(lambda: who.store.add_event(row["id"], who.user, kind, now))


def _revoke(who: Who, handoff_id: UUID) -> None:
    row = who.store.handoff(handoff_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    if row["sender_id"] != who.user:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only the sender can revoke it")
    # The package and its key go at once; the row stays (410) until the purge.
    _call(lambda: who.store.delete_objects([row["storage_path"]]))
    _call(
        lambda: who.store.update_handoff(
            handoff_id, {"status": "revoked", "revoked_at": _now(), "wrapped_key": None}
        )
    )
    _call(lambda: who.store.add_event(handoff_id, who.user, "revoked", _now()))
    logger.info("Handoff revoked (%s)", handoff_id)


def _item(who: Who, row: Row, role: Role, members: list[Row], now: datetime) -> InboxItem:
    replied = any(r["author_id"] != row["sender_id"] for r in who.store.replies(row["id"]))
    state: InboxStatus
    if row["status"] == "revoked":
        state = "revoked"
    elif row["expires_at"] <= now:
        state = "expired"
    elif replied:
        state = "replied"
    elif any(m.get("picked_up_at") for m in members):
        state = "picked_up"
    elif any(m.get("opened_at") for m in members):
        state = "opened"
    else:
        state = "unopened"
    return InboxItem(
        id=row["id"],
        title=row["title"],
        sender_name=row["sender_name"],
        role=role,
        status=state,
        created_at=row["created_at"],
        expires_at=row["expires_at"],
        recipients=[m["email"] for m in members] if role == "sender" else [],
    )
