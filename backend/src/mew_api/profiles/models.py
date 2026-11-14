"""Settings payloads (mirrored by zod schemas in packages/shared/src/settings.ts)."""

import re
from typing import Annotated, Any, Literal, get_args

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, field_validator

VoiceId = Annotated[str, StringConstraints(pattern=r"^[A-Za-z0-9]{8,64}$")]
#: The language neb listens and speaks in (mirrors NEB_LANGUAGES in language.ts).
NebLanguage = Literal["en", "fr", "bn", "zh"]

#: The notebook's rebindable shortcuts (K2; mirrors SHORTCUT_ACTIONS in shortcuts.ts).
ShortcutAction = Literal[
    "new_notebook",
    "new_chapter",
    "new_page",
    "rename",
    "jump",
    "import_pdf",
    "check_work",
    "move_up",
    "move_down",
    "undo",
    "redo",
    "pen",
    "eraser",
    "highlighter",
    "lasso",
]
#: Two keys at most: Ctrl or Alt with a key, or a key alone (the same rule as the database's).
SHORTCUT_BINDING = (
    r"^(?:(?:Ctrl|Alt)\+)?(?:[A-Z0-9]|F(?:[1-9]|1[0-2])|Arrow(?:Up|Down|Left|Right)|Enter|Space"
    r"|Tab|Escape|Backspace|Delete|Insert|Home|End|PageUp|PageDown|Comma|Period|Slash|Semicolon"
    r"|Quote|Minus|Equal|BracketLeft|BracketRight|Backslash|Backquote)$"
)
ShortcutBinding = Annotated[str, StringConstraints(pattern=SHORTCUT_BINDING)]
_ACTIONS = set(get_args(ShortcutAction))


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
    language: NebLanguage = "en"
    #: Lets the app keep Mew's decisions to improve it (M10). Off unless the student opts in.
    mew_logging_opt_in: bool = False
    #: Notes Check keeps a searchable copy of the notes' text (S3.5). On unless turned off.
    notes_index: bool = True
    onboarded: bool = False
    #: The student's own shortcuts (K2): only the actions they changed.
    shortcuts: dict[str, str] = Field(default_factory=dict)
    #: The one-time "Shortcuts got simpler" card was read (K2).
    shortcuts_notice_seen: bool = False
    #: After a full solution, a similar problem to do alone (K6). On unless turned off.
    your_turn_after_solution: bool = True
    quiz_saved_moments: bool = True
    #: A desktop notification when saved moments' checks are due (K8: opt-in).
    notify_moment_checks: bool = False
    #: neb learns the student's handwriting from their corrections (K10). On unless turned off.
    learn_handwriting: bool = True

    @field_validator("shortcuts", mode="before")
    @classmethod
    def _known_shortcuts(cls, value: Any) -> dict[str, str]:
        """Keeps the bindings this version understands (another version may know more)."""
        if not isinstance(value, dict):
            return {}
        return {
            action: binding
            for action, binding in value.items()
            if action in _ACTIONS
            and isinstance(binding, str)
            and re.fullmatch(SHORTCUT_BINDING, binding)
        }


class SettingsPatch(BaseModel):
    """A change from the settings screen: only the keys being changed."""

    model_config = ConfigDict(extra="forbid")

    mew_threshold: float | None = Field(default=None, ge=0.3, le=0.95)
    answer_style: Literal["hints_first", "direct"] | None = None
    captions: bool | None = None
    auto_check: bool | None = None
    listen_on_open: bool | None = None
    voice_id: VoiceId | None = None
    language: NebLanguage | None = None
    mew_logging_opt_in: bool | None = None
    notes_index: bool | None = None
    onboarded: bool | None = None
    shortcuts: Annotated[dict[ShortcutAction, ShortcutBinding], Field(max_length=15)] | None = None
    shortcuts_notice_seen: bool | None = None
    your_turn_after_solution: bool | None = None
    quiz_saved_moments: bool | None = None
    notify_moment_checks: bool | None = None
    learn_handwriting: bool | None = None
