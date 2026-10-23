"""Wire models for device sign-in (camelCase, like the web app's schemas in
packages/shared/src/devices.ts)."""

from datetime import datetime
from typing import Annotated
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, StringConstraints
from pydantic.alias_generators import to_camel

from .tokens import CHALLENGE_PATTERN, CODE_PATTERN, TOKEN_PATTERN, VERIFIER_PATTERN

Challenge = Annotated[str, StringConstraints(pattern=CHALLENGE_PATTERN.pattern)]
Verifier = Annotated[str, StringConstraints(pattern=VERIFIER_PATTERN.pattern)]
Code = Annotated[str, StringConstraints(pattern=CODE_PATTERN.pattern)]
Token = Annotated[str, StringConstraints(pattern=TOKEN_PATTERN.pattern)]
DeviceName = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=80)]


class _Camel(BaseModel):
    model_config = ConfigDict(extra="forbid", alias_generator=to_camel, populate_by_name=True)


class LinkCodeRequest(_Camel):
    challenge: Challenge


class LinkCode(_Camel):
    code: str
    expires_in_s: int


class ExchangeRequest(_Camel):
    code: Code
    verifier: Verifier
    device_name: DeviceName


class IssuedToken(_Camel):
    """Returned once, to the desktop app that redeemed the code."""

    token: str
    device_id: UUID


class TokenCheck(_Camel):
    token: Token


class VerifiedDevice(_Camel):
    user_id: str
    device_id: UUID
    scopes: list[str]
    # Found in the development-only local store (local mode): never sent to the web app.
    local: bool = Field(default=False, exclude=True)


class Device(_Camel):
    """A device as its owner sees it (never the token or its hash)."""

    id: UUID
    device_name: str
    created_at: datetime
    last_used_at: datetime | None
    revoked_at: datetime | None


class DeviceList(_Camel):
    devices: list[Device]
