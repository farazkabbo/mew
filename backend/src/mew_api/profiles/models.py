"""Settings payloads (mirrored by zod schemas in packages/shared/src/settings.ts)."""

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

VoiceId = Annotated[str, StringConstraints(pattern=r"^[A-Za-z0-9]{8,64}$")]


class UserSettings(BaseModel):
    """What the app reads. Missing keys take their defaults; unknown keys (from other app
    versions) are ignored rather than rejected."""

    model_config = ConfigDict(extra="ignore")

    mew_threshold: float = Field(default=0.7, ge=0.3, le=0.95)
    answer_style: Literal["hints_first", "direct"] = "hints_first"
    captions: bool = True
    auto_check: bool = True
    listen_on_open: bool = False
    voice_id: VoiceId | None = None
    #: Lets the app keep Mew's decisions to improve it (M10). Off unless the student opts in.
    mew_logging_opt_in: bool = False
    #: Notes Check keeps a searchable copy of the notes' text (S3.5). On unless turned off.
    notes_index: bool = True
    onboarded: bool = False


class SettingsPatch(BaseModel):
    """A change from the settings screen: only the keys being changed."""

    model_config = ConfigDict(extra="forbid")

    mew_threshold: float | None = Field(default=None, ge=0.3, le=0.95)
    answer_style: Literal["hints_first", "direct"] | None = None
    captions: bool | None = None
    auto_check: bool | None = None
    listen_on_open: bool | None = None
    voice_id: VoiceId | None = None
    mew_logging_opt_in: bool | None = None
    notes_index: bool | None = None
    onboarded: bool | None = None
