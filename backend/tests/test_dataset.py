import json
from pathlib import Path
from typing import Any

import httpx
import pytest

from mew_api.dataset.__main__ import main
from mew_api.dataset.export import Example, from_supabase, resolve, split_of
from mew_api.dataset.features import mew_feature_text

REPO = Path(__file__).resolve().parents[2]
#: Shared with the TypeScript implementation (packages/shared/src/mew-features.test.ts).
CASES: list[dict[str, Any]] = json.loads(
    (REPO / "packages/shared/src/mew-features.cases.json").read_text(encoding="utf-8")
)


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_features_match_the_web_app(case: dict[str, Any]) -> None:
    text = mew_feature_text(case["input"])
    if case["text"] is not None:
        assert text == case["text"]
        return
    said = text.split(" | ")[0]
    assert len(case["input"]["lastUtterance"]) > 300
    assert len(said) == case["expectLength"]["utteranceChars"]
    assert said.endswith(case["expectLength"]["endsWith"])


def test_conflicting_labels_go_to_the_majority_and_ties_are_dropped() -> None:
    examples = [
        Example("a", "ignore", "seed"),
        Example("a", "ignore", "file"),
        Example("a", "give_hint", "file"),
        Example("b", "ignore", "seed"),
        Example("b", "check_work", "file"),
    ]
    kept, dropped = resolve(examples)
    assert kept == [Example("a", "ignore", "seed")]
    assert dropped == 1


def test_splits_are_deterministic_and_roughly_80_10_10() -> None:
    texts = [f"example {i}" for i in range(2000)]
    splits = [split_of(t) for t in texts]
    assert splits == [split_of(t) for t in texts]
    assert 150 < splits.count("test") < 250 and 150 < splits.count("val") < 250


def test_supabase_export_only_includes_students_still_opted_in() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["apikey"] == "sb_secret_x"
        if request.url.path.endswith("/profiles"):
            return httpx.Response(
                200,
                json=[
                    {"id": "in", "settings": {"mew_logging_opt_in": True}},
                    {"id": "out", "settings": {"mew_logging_opt_in": False}},
                ],
            )
        gate = CASES[0]["input"]
        return httpx.Response(
            200,
            json=[
                {"user_id": "in", "input": gate, "human_label": "answer_question"},
                {"user_id": "out", "input": gate, "human_label": "ignore"},
                {"user_id": "in", "input": gate, "human_label": "not-a-label"},
            ],
        )

    client = httpx.Client(transport=httpx.MockTransport(handler))
    examples = from_supabase("https://proj.supabase.co", "sb_secret_x", client)
    assert [(e.label, e.source) for e in examples] == [("answer_question", "supabase")]


def test_cli_builds_a_dataset_from_the_seed_cases_and_downloads(tmp_path: Path) -> None:
    labels = tmp_path / "labels.jsonl"
    labels.write_text(
        json.dumps({"input": CASES[1]["input"], "human_label": "check_work"}) + "\n",
        encoding="utf-8",
    )
    out = tmp_path / "data"
    code = main(
        [
            "--out",
            str(out),
            "--seed",
            str(REPO / "frontend/evals/mew.cases.json"),
            "--jsonl",
            str(labels),
        ]
    )
    assert code == 0
    rows = [
        json.loads(line)
        for name in ("train", "val", "test")
        for line in (out / f"{name}.jsonl").read_text(encoding="utf-8").splitlines()
    ]
    assert len(rows) > 20
    assert {"check_work", "ignore", "answer_question"} <= {r["label"] for r in rows}
    meta = json.loads((out / "meta.json").read_text(encoding="utf-8"))
    assert meta["features"] == "mew-features.v1"
