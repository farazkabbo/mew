"""The classifier's input text for one gate decision. Must match mewFeatureText in
packages/shared/src/mew-features.ts exactly: both are tested against mew-features.cases.json."""

import re
from collections.abc import Mapping
from typing import Any

MEW_FEATURES_VERSION = "mew-features.v1"

_UTTERANCE_CHARS = 300
_CONTEXT_CHARS = 150
_CONTEXT_SEGMENTS = 2
# JavaScript's \s: Unicode whitespace plus the BOM, which Python's \s doesn't include.
_WHITESPACE = re.compile(r"[\s﻿]+")


def mew_feature_text(gate_input: Mapping[str, Any]) -> str:
    """`gate_input` is a MewInput as JSON (camelCase keys), as logged in mew_events.input."""
    signals: Mapping[str, Any] = gate_input.get("notebookSignals") or {}
    context = [_tail(s, _CONTEXT_CHARS) for s in gate_input.get("recentTranscript", [])]
    lines = int(signals.get("linesWrittenLast60s", 0))
    parts = [
        _tail(gate_input.get("lastUtterance", ""), _UTTERANCE_CHARS) or "(nothing said)",
        "before: " + (" / ".join(c for c in context[-_CONTEXT_SEGMENTS:] if c) or "-"),
        "writing: " + (_tail(signals.get("activeRegionText") or "", _CONTEXT_CHARS) or "-"),
        "; ".join(
            [
                f"trigger {str(gate_input.get('trigger', 'utterance')).replace('_', ' ', 1)}",
                f"summoned {_yes(gate_input.get('explicitSummon'))}",
                f"tutor spoke {_yes(gate_input.get('tutorSpokeRecently'))}",
                f"last stroke {_stroke_bucket(signals.get('msSinceLastStroke'))}",
                f"erased {_yes(signals.get('justErased'))}",
                f"lines {'3+' if lines >= 3 else lines}",
            ]
        ),
    ]
    return " | ".join(parts)


def _tail(text: str, limit: int) -> str:
    clean = _WHITESPACE.sub(" ", text).strip()
    return clean if len(clean) <= limit else clean[-limit:].lstrip()


def _yes(value: object) -> str:
    return "yes" if value is True else "no"


def _stroke_bucket(ms: object) -> str:
    if ms is None:
        return "none"
    value = float(ms) if isinstance(ms, int | float) else 0.0
    if value < 2_000:
        return "just now"
    if value < 10_000:
        return "seconds ago"
    if value < 60_000:
        return "a minute ago"
    return "a while ago"
