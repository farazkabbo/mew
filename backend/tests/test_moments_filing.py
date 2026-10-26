"""K8 filing and check planning (pure), and parity with the TypeScript side."""

import json
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import UUID

import pytest

from mew_api.moments.checks import NEW_PER_DAY, RecentCard, plan_new_check, room_today
from mew_api.moments.filing import (
    Correction,
    Memory,
    Moment,
    Node,
    decide,
    path_of,
    subject_of,
    unsorted_node_id,
)
from mew_api.moments.source import source_key

SHARED = Path(__file__).resolve().parents[2] / "packages" / "shared" / "src"

PHYSICS = UUID("00000000-0000-4000-8000-000000000001")
CH1 = UUID("00000000-0000-4000-8000-000000000011")
CH3 = UUID("00000000-0000-4000-8000-000000000013")
CH5 = UUID("00000000-0000-4000-8000-000000000015")
CHEMISTRY = UUID("00000000-0000-4000-8000-000000000002")
CHEM2 = UUID("00000000-0000-4000-8000-000000000022")
UNSORTED = unsorted_node_id("user_test")

NODES = [
    Node(PHYSICS, None, "Physics", "a0", "physics"),
    Node(CH1, PHYSICS, "Chapter 1 · Measurement", "a0"),
    Node(CH3, PHYSICS, "Chapter 3 · Kinematics", "a1"),
    Node(CH5, PHYSICS, "Chapter 5 · Gravity", "a2"),
    Node(CHEMISTRY, None, "Chemistry", "a1"),
    Node(CHEM2, CHEMISTRY, "Chapter 2 · Bonds", "a0"),
]
TEXTS = {
    CH3: [
        "3.4 Projectile motion: a ball thrown sideways follows a parabola under gravity.",
        "Velocity-time graphs: the slope is the acceleration.",
    ],
    CH5: ["Gravity pulls every mass; near the Earth g is 9.8 m/s²."],
    CHEM2: ["Covalent bonds share electrons; ionic bonds transfer them."],
}


def test_a_physics_moment_lands_in_the_chapter_that_covers_it() -> None:
    """The K8 acceptance: a projectile-motion video, while Chemistry is open."""
    decision = decide(
        Moment("physics", ("projectile motion", "gravity")), NODES, TEXTS, unsorted_id=UNSORTED
    )
    assert decision.method == "content_match"
    assert decision.node_id == CH3
    assert decision.matched == "projectile motion"
    assert decision.score >= 0.8
    assert path_of(CH3, NODES) == ["Physics", "Chapter 3 · Kinematics"]


def test_a_concept_in_several_chapters_isnt_specific_enough() -> None:
    decision = decide(Moment("physics", ("gravity",)), NODES, TEXTS, unsorted_id=UNSORTED)
    # "gravity" is in Chapters 3 and 5: the notebook, with those chapters first as chips.
    assert decision.method == "subject_match"
    assert decision.node_id == PHYSICS
    assert decision.alternatives[:2] in ([CH3, CH5], [CH5, CH3])
    assert len(decision.alternatives) == 3


def test_the_subject_alone_files_it_in_the_notebook() -> None:
    decision = decide(Moment("chemistry", ("titration",)), NODES, TEXTS, unsorted_id=UNSORTED)
    assert decision.method == "subject_match"
    assert decision.node_id == CHEMISTRY  # no subject set: its name says chemistry
    assert decision.alternatives == [CHEM2]


def test_no_match_goes_to_unsorted_with_a_new_notebook_offer() -> None:
    decision = decide(Moment("biology", ("mitosis",)), NODES, TEXTS, unsorted_id=UNSORTED)
    assert decision.method == "unsorted"
    assert decision.node_id == UNSORTED
    assert decision.new_notebook == "Biology"  # offered, never made without a tap
    # A subject the student has a notebook for is never offered again as a new one.
    other = decide(Moment("other", ("cooking",)), NODES, TEXTS, unsorted_id=UNSORTED)
    assert other.new_notebook is None


def test_the_source_remembers_where_its_moments_went() -> None:
    decision = decide(
        Moment("physics", ("projectile motion",)),
        NODES,
        TEXTS,
        unsorted_id=UNSORTED,
        memory=Memory(CHEM2, corrected=True),
    )
    assert (decision.method, decision.node_id) == ("source_memory", CHEM2)
    # A remembered place that's gone (trashed) isn't used.
    gone = [*NODES[:-1], Node(CHEM2, CHEMISTRY, "Chapter 2 · Bonds", "a0", deleted=True)]
    later = decide(
        Moment("physics", ("projectile motion",)),
        gone,
        TEXTS,
        unsorted_id=UNSORTED,
        memory=Memory(CHEM2, corrected=True),
    )
    assert later.node_id == CH3


def test_change_teaches_for_similar_moments() -> None:
    moved = [Correction(CH3, CH1, ("projectile motion",))]
    decision = decide(
        Moment("physics", ("projectile motion",)),
        NODES,
        TEXTS,
        unsorted_id=UNSORTED,
        corrections=moved,
    )
    assert decision.node_id != CH3  # not filed back where the student took it from
    assert decision.method == "subject_match"
    assert decision.alternatives[0] == CH1  # where they put the last one: the first chip

    # Moved there twice: similar moments go there on their own.
    twice = decide(
        Moment("physics", ("projectile motion",)),
        NODES,
        TEXTS,
        unsorted_id=UNSORTED,
        corrections=moved * 2,
    )
    assert (twice.method, twice.node_id) == ("content_match", CH1)


def test_sticky_comes_after_content_and_subject() -> None:
    sticky = decide(Moment(None, ()), NODES, TEXTS, unsorted_id=UNSORTED, sticky_id=CHEM2)
    assert (sticky.method, sticky.node_id) == ("sticky", CHEM2)
    content = decide(
        Moment("physics", ("projectile motion",)),
        NODES,
        TEXTS,
        unsorted_id=UNSORTED,
        sticky_id=CHEM2,
    )
    assert content.method == "content_match"


def test_subjects_from_names() -> None:
    assert subject_of(Node(CH1, None, "AP Calculus", "a0")) == "math"
    assert subject_of(Node(CH1, None, "Diary", "a0")) is None
    assert subject_of(Node(CH1, None, "Diary", "a0", "history")) == "history"


@pytest.mark.parametrize("case", json.loads((SHARED / "unsorted-id.cases.json").read_text("utf-8")))
def test_the_unsorted_id_matches_the_web_app(case: dict[str, str]) -> None:
    assert str(unsorted_node_id(case["userId"])) == case["id"]


@pytest.mark.parametrize("case", json.loads((SHARED / "source-key.cases.json").read_text("utf-8")))
def test_source_keys_match_the_web_app(case: dict[str, object]) -> None:
    source = case["source"]
    assert isinstance(source, dict)
    assert source_key(source.get("app"), source.get("title"), source.get("url")) == case["key"]


NOW = datetime(2026, 10, 26, 12, tzinfo=UTC)


def card(n: int, hints: tuple[str, ...], days_ago: float, merged: int = 0) -> RecentCard:
    return RecentCard(UUID(int=n), hints, NOW - timedelta(days=days_ago), merged)


def test_a_new_check_is_due_about_a_day_later() -> None:
    plan = plan_new_check(["Acceleration"], NOW, [], 0)
    assert plan.action == "active"
    assert plan.due_at == NOW + timedelta(days=1)


def test_moments_about_one_concept_in_a_week_share_a_card() -> None:
    plan = plan_new_check(
        ["acceleration ", "Gravity"],
        NOW,
        [card(1, ("Acceleration",), 2), card(2, ("Acceleration",), 5)],
        3,
    )
    assert (plan.action, plan.card_id) == ("merge", UUID(int=1))
    # Older than a week, or full: a card of its own.
    assert (
        plan_new_check(["acceleration"], NOW, [card(1, ("acceleration",), 8)], 0).action == "active"
    )
    assert (
        plan_new_check(["acceleration"], NOW, [card(1, ("acceleration",), 1, 20)], 0).action
        == "active"
    )
    # No concepts: never merged.
    assert plan_new_check([], NOW, [card(1, (), 1)], 0).action == "active"


def test_at_most_15_new_cards_a_day() -> None:
    assert plan_new_check(["x"], NOW, [], NEW_PER_DAY - 1).action == "active"
    assert plan_new_check(["x"], NOW, [], NEW_PER_DAY).action == "queued"
    assert room_today(NEW_PER_DAY + 3) == 0
    assert room_today(4) == NEW_PER_DAY - 4
