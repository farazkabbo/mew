"""Builds Mew v2's dataset: labelled gate decisions → train/val/test JSONL for fine-tuning.

Sources (any combination):
- Supabase: mew_events with a human label, from users who are *still* opted in (a student who
  opts out is left out of every later export). Needs the secret key, so run it on a trusted
  machine; the output contains students' words and must be handled like the database.
- JSONL files downloaded from the labelling screen ("Teach Mew").
- The seed cases of the v1 gate eval (frontend/evals/mew.cases.json).
"""

import hashlib
import json
from collections import Counter, defaultdict
from collections.abc import Iterable, Iterator, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx

from ..mew_events.models import MEW_LABELS
from ..supabase_rest import SupabaseRest
from .features import MEW_FEATURES_VERSION, mew_feature_text

_PAGE = 1000


@dataclass(frozen=True)
class Example:
    text: str
    label: str
    source: str


def from_events(events: Iterable[Mapping[str, Any]], source: str) -> Iterator[Example]:
    """Labelled events ({input, human_label, ...}) → examples; anything malformed is skipped."""
    for event in events:
        label = event.get("human_label")
        gate_input = event.get("input")
        if label in MEW_LABELS and isinstance(gate_input, dict):
            yield Example(mew_feature_text(gate_input), str(label), source)


def from_jsonl(path: Path) -> Iterator[Example]:
    with path.open(encoding="utf-8") as lines:
        rows = (json.loads(line) for line in lines if line.strip())
        yield from from_events(rows, f"file:{path.name}")


def from_seed_cases(path: Path) -> Iterator[Example]:
    """The v1 gate eval's cases. Ambiguous ones (several acceptable labels) have no single
    answer to learn, so they're left out."""
    for case in json.loads(path.read_text(encoding="utf-8")):
        if "expect" not in case:
            continue
        trigger = case.get("trigger", "utterance")
        gate_input = {
            "trigger": trigger,
            "lastUtterance": case.get("utterance", ""),
            "recentTranscript": [],
            "notebookSignals": {
                "msSinceLastStroke": None,
                "justErased": False,
                "linesWrittenLast60s": 0,
                **case.get("signals", {}),
            },
            "tutorSpokeRecently": False,
            "explicitSummon": trigger == "summon",
        }
        yield from from_events([{"input": gate_input, "human_label": case["expect"]}], "seed")


def from_supabase(url: str, secret_key: str, client: httpx.Client | None = None) -> list[Example]:
    rest = SupabaseRest(url, api_key=secret_key, user_token=None, client=client)
    consenting = {
        row["id"]
        for row in _pages(rest, "profiles", {"select": "id,settings"})
        if isinstance(row.get("settings"), dict) and row["settings"].get("mew_logging_opt_in")
    }
    events = (
        row
        for row in _pages(
            rest,
            "mew_events",
            {"select": "user_id,input,human_label", "human_label": "not.is.null"},
        )
        if row.get("user_id") in consenting
    )
    return list(from_events(events, "supabase"))


def _pages(rest: SupabaseRest, table: str, params: dict[str, str]) -> Iterator[Mapping[str, Any]]:
    offset = 0
    while True:
        rows = rest._get(
            table, {**params, "order": "id", "limit": str(_PAGE), "offset": str(offset)}
        )
        yield from rows
        if len(rows) < _PAGE:
            return
        offset += _PAGE


def resolve(examples: Iterable[Example]) -> tuple[list[Example], int]:
    """One example per text: the majority label (ties dropped). Returns (kept, dropped)."""
    by_text: dict[str, list[Example]] = defaultdict(list)
    for example in examples:
        by_text[example.text].append(example)
    kept: list[Example] = []
    dropped = 0
    for text, group in sorted(by_text.items()):
        votes = Counter(e.label for e in group).most_common()
        if len(votes) > 1 and votes[0][1] == votes[1][1]:
            dropped += 1
            continue
        kept.append(Example(text, votes[0][0], group[0].source))
    return kept, dropped


def split_of(text: str) -> str:
    """Deterministic: the same example is always in the same split, whatever else changes."""
    bucket = int(hashlib.sha256(text.encode("utf-8")).hexdigest(), 16) % 10
    return "test" if bucket == 0 else "val" if bucket == 1 else "train"


def write_dataset(examples: list[Example], out: Path) -> dict[str, Counter[str]]:
    out.mkdir(parents=True, exist_ok=True)
    counts: dict[str, Counter[str]] = {name: Counter() for name in ("train", "val", "test")}
    files = {name: (out / f"{name}.jsonl").open("w", encoding="utf-8") for name in counts}
    try:
        for example in examples:
            name = split_of(example.text)
            row = {"text": example.text, "label": example.label, "source": example.source}
            files[name].write(json.dumps(row, ensure_ascii=False) + "\n")
            counts[name][example.label] += 1
    finally:
        for handle in files.values():
            handle.close()
    meta = {
        "features": MEW_FEATURES_VERSION,
        "labels": list(MEW_LABELS),
        "counts": {name: dict(c) for name, c in counts.items()},
    }
    (out / "meta.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
    return counts
