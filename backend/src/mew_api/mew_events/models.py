"""Gate decisions as logged for Mew v2 (mirrors MewInput / MewOutput in
packages/shared/src/mew.ts; field names are camelCase on the wire, as in the web app)."""

from datetime import datetime
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, StringConstraints
from pydantic.alias_generators import to_camel

MewLabel = Literal[
    "ignore", "answer_question", "check_work", "give_hint", "complete_step", "draw_visual"
]
MEW_LABELS: tuple[MewLabel, ...] = (
    "ignore",
    "answer_question",
    "check_work",
    "give_hint",
    "complete_step",
    "draw_visual",
)
DecisionSource = Literal["model", "rule", "fallback", "checker", "local"]

Text500 = Annotated[str, StringConstraints(max_length=500)]


class _Camel(BaseModel):
    model_config = ConfigDict(extra="forbid", alias_generator=to_camel, populate_by_name=True)


class NotebookSignals(_Camel):
    ms_since_last_stroke: int | None = Field(ge=0)
    just_erased: bool
    lines_written_last60s: int = Field(ge=0, le=1000, alias="linesWrittenLast60s")
    active_region_text: Text500 | None = None


class GateInput(_Camel):
    trigger: Literal["utterance", "pen_pause", "summon"]
    last_utterance: Text500
    recent_transcript: list[Text500] = Field(max_length=6)
    notebook_signals: NotebookSignals
    tutor_spoke_recently: bool
    explicit_summon: bool


class GateOutput(_Camel):
    label: MewLabel
    confidence: float = Field(ge=0, le=1)
    reason: Annotated[str, StringConstraints(max_length=200)]


class MewEventCreate(_Camel):
    """One gate decision to keep (the student has opted in)."""

    input: GateInput
    output: GateOutput
    source: DecisionSource
    latency_ms: int = Field(ge=0, le=120_000)

    def stored_output(self) -> dict[str, object]:
        """mew_events.output: the decision plus how it was made."""
        return {
            **self.output.model_dump(by_alias=True),
            "source": self.source,
            "latencyMs": self.latency_ms,
        }


class MewEvent(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: UUID
    input: dict[str, object]
    output: dict[str, object]
    human_label: MewLabel | None
    created_at: datetime


class MewEventPage(BaseModel):
    events: list[MewEvent]


class LabelUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    #: None clears the label.
    human_label: MewLabel | None


class LogResult(BaseModel):
    logged: bool


#: Events listed per request, and exported at most (the labelling screen and its download).
PAGE_SIZE = 50
MAX_EXPORT = 1000  # Supabase returns at most 1000 rows per request
#: Kept per local-mode user (memory).
MAX_LOCAL_EVENTS = 5000
