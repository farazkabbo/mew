"""Check questions for saved moments (K8, docs/NOTEBOOKS_K.md §4.7): when each becomes a review
card. Pure; the store applies it.

- A moment about the same concept as a card made in the last 7 days joins that card (one card,
  several moments), so a week of videos on one idea is one question, not five.
- Otherwise it's a new card, first due about a day later.
- At most 15 new cards a day; the rest wait in a queue and become due, oldest first, on days
  with room.
"""

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Literal
from uuid import UUID

NEW_PER_DAY = 15
MERGE_DAYS = 7
FIRST_DUE = timedelta(days=1)


@dataclass(frozen=True)
class RecentCard:
    id: UUID
    hints: tuple[str, ...]
    created_at: datetime
    merged: int


@dataclass(frozen=True)
class Plan:
    action: Literal["merge", "active", "queued"]
    #: The card it joins (merge).
    card_id: UUID | None = None
    due_at: datetime | None = None


def _concepts(hints: Sequence[str]) -> set[str]:
    return {" ".join(h.lower().split()) for h in hints if h.strip()}


def plan_new_check(
    hints: Sequence[str],
    now: datetime,
    recent: Sequence[RecentCard],
    made_today: int,
    *,
    max_merged: int = 20,
) -> Plan:
    """What a new moment's check becomes: part of a recent card about the same concept, a new card
    due tomorrow, or one waiting in the queue (the day already has 15)."""
    concepts = _concepts(hints)
    week_ago = now - timedelta(days=MERGE_DAYS)
    same = [
        card
        for card in recent
        if card.created_at >= week_ago
        and card.merged < max_merged
        and concepts
        and concepts & _concepts(card.hints)
    ]
    if same:
        newest = max(same, key=lambda c: c.created_at)
        return Plan("merge", card_id=newest.id)
    if made_today >= NEW_PER_DAY:
        return Plan("queued")
    return Plan("active", due_at=now + FIRST_DUE)


def room_today(made_today: int) -> int:
    """How many queued cards may become due today."""
    return max(0, NEW_PER_DAY - made_today)
