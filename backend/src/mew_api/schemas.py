"""API payloads. Mirrors the zod schemas in packages/shared/src."""

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints


class _Model(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class ApiHealth(_Model):
    status: Literal["ok"] = "ok"
    service: Literal["api"] = "api"
    version: str


class ApiWhoAmI(_Model):
    user_id: str


MathStep = Annotated[str, StringConstraints(min_length=1, max_length=300)]


class ApiMathCheckRequest(_Model):
    """Consecutive lines of a student's working, as LaTeX (from handwriting recognition)."""

    steps: list[MathStep] = Field(min_length=1, max_length=8)


class ApiStepResult(_Model):
    index: int
    verdict: Literal["correct", "incorrect", "unknown"]
    reason: str
    detail: str | None = None


class ApiMathCheckResponse(_Model):
    results: list[ApiStepResult]
