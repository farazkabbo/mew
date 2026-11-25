"""Handoff's API shapes. Nothing here holds a package's content: the service only ever sees
its ciphertext, its size, its title and who it's for."""

from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator
from pydantic.alias_generators import to_camel

MAX_PACKAGE_BYTES = 25 * 1024 * 1024
MAX_RECIPIENTS = 5
EXPIRY_DAYS = (1, 7, 30)

EventType = Literal[
    "created", "opened", "walkthrough_played", "asked", "replied", "picked_up", "revoked", "expired"
]
# The events a member may record (the rest are the service's own).
MemberEvent = Literal["opened", "walkthrough_played", "asked", "picked_up"]


class Model(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="forbid")


def _email(value: str) -> str:
    value = value.strip().lower()
    local, _, host = value.partition("@")
    if not local or "." not in host or len(value) > 254 or any(c.isspace() for c in value):
        raise ValueError("not an email address")
    return value


class Recipient(Model):
    email: str

    @field_validator("email")
    @classmethod
    def _check(cls, value: str) -> str:
        return _email(value)


class HandoffCreate(Model):
    title: str = Field(min_length=1, max_length=120)
    sender_name: str = Field(min_length=1, max_length=80)
    recipients: list[Recipient] = Field(min_length=1, max_length=MAX_RECIPIENTS)
    expires_in_days: int
    size_bytes: int = Field(ge=1, le=MAX_PACKAGE_BYTES)
    # The content key, wrapped by the web server's key (opaque here).
    wrapped_key: str = Field(min_length=16, max_length=200)

    @field_validator("expires_in_days")
    @classmethod
    def _days(cls, value: int) -> int:
        if value not in EXPIRY_DAYS:
            raise ValueError("expiry must be 1, 7 or 30 days")
        return value


class HandoffCreated(Model):
    id: UUID


class EventIn(Model):
    type: MemberEvent


class ReplyIn(Model):
    author_name: str = Field(min_length=1, max_length=80)
    body: str = Field(min_length=1, max_length=2000)


class Reply(Model):
    id: UUID
    author_name: str
    body: str
    created_at: datetime
    mine: bool


class Member(Model):
    email: str
    opened_at: datetime | None
    picked_up_at: datetime | None


class Event(Model):
    type: EventType
    at: datetime


class HandoffView(Model):
    """What a member sees. `wrapped_key` goes only to members; `members` and `events` (the audit:
    who opened it, when) only to the sender."""

    id: UUID
    title: str
    sender_name: str
    role: Literal["sender", "recipient"]
    status: Literal["sent", "draft"]
    expires_at: datetime
    created_at: datetime
    size_bytes: int
    wrapped_key: str
    replies: list[Reply]
    members: list[Member] | None = None
    events: list[Event] | None = None


class Teaser(Model):
    """All a link shows to someone who isn't signed in."""

    sender_first_name: str


InboxStatus = Literal["unopened", "opened", "picked_up", "replied", "expired", "revoked"]


class InboxItem(Model):
    id: UUID
    title: str
    sender_name: str
    role: Literal["sender", "recipient"]
    status: InboxStatus
    created_at: datetime
    expires_at: datetime
    # Received: who sent it is `sender_name`; sent: who it went to.
    recipients: list[str]


class Inbox(Model):
    items: list[InboxItem]


class People(Model):
    """People the user handed off to or received from: the recipient picker's suggestions."""

    emails: list[str]


class Purged(Model):
    count: int
