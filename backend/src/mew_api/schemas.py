"""API payloads. Mirrors the zod schemas in packages/shared/src."""

from typing import Literal

from pydantic import BaseModel, ConfigDict


class _Model(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class ApiHealth(_Model):
    status: Literal["ok"] = "ok"
    service: Literal["api"] = "api"
    version: str


class ApiWhoAmI(_Model):
    user_id: str
