"""Wire models for coach-mode walkthroughs (camelCase, like packages/shared/src/coach.ts).

A walkthrough is a task the student is being coached through on their screen (Screen Coach S4,
decision 10): its planned steps, how each went, and where it stands. Text only: never a
screenshot, never what the verifier saw. The web app's server runs the state machine; this
service checks every write again and stores it.
"""

import re
from datetime import datetime
from typing import Annotated, Literal, Self
from uuid import UUID

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, model_validator
from pydantic.alias_generators import to_camel

MAX_STEPS = 15
HINT_LEVELS = 3
RETRIES = 3

_CONTROL = re.compile(r"[\x00-\x1f\x7f]")
_APP = re.compile(r"^[a-z0-9 ._+()-]+\.exe$")


def _line(text: str) -> str:
    """One line of plain text: no control characters, not blank."""
    if _CONTROL.search(text):
        raise ValueError("control characters aren't allowed")
    if not text.strip():
        raise ValueError("can't be blank")
    return text


Line = Annotated[str, AfterValidator(_line)]
AppName = Annotated[str, Field(max_length=64, pattern=_APP.pattern)]

Status = Literal["active", "paused", "stopped", "completed"]
Phase = Literal["awaiting", "confirming"]


class _Camel(BaseModel):
    model_config = ConfigDict(extra="forbid", alias_generator=to_camel, populate_by_name=True)


class WalkthroughStep(_Camel):
    instruction: Line = Field(max_length=160)
    success_condition: Line = Field(max_length=160)
    hint: Line = Field(max_length=160)
    explicit: Line = Field(max_length=220)
    #: The highest hint level given (0 to 3).
    hints: int = Field(ge=0, le=HINT_LEVELS)
    #: Every check of the step (each a model call).
    checks: int = Field(ge=0, le=1000)
    #: Checks that didn't finish it since it was started or resumed (the retry cap).
    misses: int = Field(ge=0, le=RETRIES + 1)
    #: How it was finished: seen on the screen, or the student said so when asked.
    outcome: Literal["checked", "confirmed"] | None

    def plan(self) -> tuple[str, str, str, str]:
        """The planned texts (fixed once the walkthrough starts)."""
        return (self.instruction, self.success_condition, self.hint, self.explicit)


Steps = Annotated[list[WalkthroughStep], Field(min_length=1, max_length=MAX_STEPS)]


class WalkthroughCreate(_Camel):
    title: Line = Field(max_length=60)
    goal: Line = Field(max_length=200)
    app: AppName | None
    steps: Steps


class WalkthroughUpdate(_Camel):
    """The progress after one event, written only if the walkthrough is still at `revision`."""

    revision: int = Field(ge=0)
    status: Status
    phase: Phase
    current: int = Field(ge=0, lt=MAX_STEPS)
    steps: Steps

    @model_validator(mode="after")
    def _current_is_a_step(self) -> Self:
        if self.current >= len(self.steps):
            raise ValueError("the current step must be one of the steps")
        return self


class WalkthroughView(_Camel):
    id: UUID
    title: str
    goal: str
    app: str | None
    status: Status
    phase: Phase
    current: int
    steps: list[WalkthroughStep]
    revision: int
    started_at: datetime
    updated_at: datetime
    completed_at: datetime | None

    def hints_used(self) -> int:
        return sum(step.hints for step in self.steps)
