"""Filing a screen moment by what the student is studying (K8, docs/NOTEBOOKS_K.md §4.6).

When the student didn't say where a moment goes, it goes where they'll look for it later: the
chapter whose material (or earlier moments) mention what it's about, the notebook for its subject,
or the Unsorted notebook. Pure: the caller loads the student's own tree and texts; nothing here
reads or logs titles or text.

Order of precedence (§4.6; "spoken" is the caller's, before this runs):
1. source memory: where the last moment from the same video, PDF or page went, or was moved to;
2. content match: a concept the answer is about, found in a chapter's course material or earlier
   moments, specific to it (score ≥ 0.80 and clear of the next by 0.15);
3. subject match: the notebook for the answer's subject, with chapter suggestions;
4. sticky: the source's place from the last two hours (the caller's memory);
5. Unsorted, with suggestions and "+ New notebook: <Subject>".

The content score: each concept hint found in a node's text counts by how specific it is — a
phrase of several words counts 0.9, one word 0.75, divided by the square root of how many places
mention it — and hints combine as 1 - Π(1 - w). So "projectile motion" found only in Chapter 3
scores 0.9 there; "gravity", in three chapters, 0.43 each. "Change teaches": a correction with a
hint in common halves the score of where the moment was taken from and adds 0.5 to where it
went: once, that place is the first suggestion; twice, similar moments are filed there.
"""

import math
import re
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Literal
from uuid import UUID

CONTENT_THRESHOLD = 0.80
CONTENT_MARGIN = 0.15
#: How much a correction lifts the place a similar moment was moved to.
CORRECTION_LIFT = 0.5
MAX_ALTERNATIVES = 3

Method = Literal["source_memory", "content_match", "subject_match", "sticky", "unsorted"]

#: What a notebook's name says it's about, when it has no subject set (notebook-tree.ts mirrors).
_SUBJECT_STEMS: Sequence[tuple[str, str]] = (
    (r"\b(phys|mechanic|optic|thermo|quantum|astro)", "physics"),
    (r"\b(chem|organic|biochem)", "chemistry"),
    (r"\b(math|calc|algebra|geometr|statist|trig|linear|discrete|account|financ)", "math"),
    (r"\b(bio|anatom|physiolog|genetic|microbio|medic|ecolog|botan|plant)", "biology"),
    (r"\b(comput|program|code|coding|software|algorithm|data|cs\b|eecs|web)", "programming"),
    (r"\b(histor|law|legal|politic|govern|civic|econom)", "history"),
    (
        r"\b(english|french|spanish|german|chinese|japanese|language|literat|writing|latin)",
        "language",
    ),
)

SUBJECT_NAMES: Mapping[str, str] = {
    "math": "Math",
    "physics": "Physics",
    "chemistry": "Chemistry",
    "biology": "Biology",
    "history": "History",
    "language": "Languages",
    "programming": "Programming",
}


@dataclass(frozen=True)
class Node:
    id: UUID
    parent_id: UUID | None
    title: str
    position: str
    subject: str | None = None
    deleted: bool = False


@dataclass(frozen=True)
class Memory:
    node_id: UUID
    corrected: bool


@dataclass(frozen=True)
class Correction:
    from_node_id: UUID | None
    to_node_id: UUID
    hints: tuple[str, ...]


@dataclass(frozen=True)
class Moment:
    """What the answer says the moment is about (no extra model call: the same answer)."""

    subject: str | None
    hints: tuple[str, ...]
    source_key: str | None = None


@dataclass
class Decision:
    method: Method
    node_id: UUID
    score: float
    #: The concept that matched ("projectile motion"), shown in the toast.
    matched: str | None = None
    alternatives: list[UUID] = field(default_factory=list)
    #: "+ New notebook: Biology" (Unsorted only, when no notebook has the subject).
    new_notebook: str | None = None


def normalise(text: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^\w\s'-]", " ", text.lower())).strip()


def subject_of(node: Node) -> str | None:
    """A notebook's subject: its own, else what its name says."""
    if node.subject:
        return node.subject
    name = node.title.lower()
    return next((subject for stem, subject in _SUBJECT_STEMS if re.search(stem, name)), None)


def _mentions(text: str, hint: str) -> bool:
    return re.search(rf"(?<![\w-]){re.escape(hint)}(?![\w-])", text) is not None


def content_scores(
    moment: Moment,
    nodes: Sequence[Node],
    texts: Mapping[UUID, Sequence[str]],
    corrections: Sequence[Correction] = (),
) -> tuple[dict[UUID, float], dict[UUID, str]]:
    """Each live node's content score (0-1) and its best-matching hint."""
    hints = [h for h in dict.fromkeys(normalise(h) for h in moment.hints) if len(h) >= 3]
    live = [n for n in nodes if not n.deleted]
    corpus = {n.id: normalise(" ".join([n.title, *texts.get(n.id, ())])) for n in live}
    found = {h: [nid for nid, text in corpus.items() if _mentions(text, h)] for h in hints}
    scores: dict[UUID, float] = {}
    matched: dict[UUID, str] = {}
    for node in live:
        miss = 1.0
        best = (0.0, "")
        for hint, places in found.items():
            if node.id not in places:
                continue
            weight = (0.9 if " " in hint else 0.75) / math.sqrt(len(places))
            miss *= 1 - weight
            if weight > best[0]:
                best = (weight, hint)
        score = 1 - miss
        if score > 0:
            scores[node.id] = score
            matched[node.id] = best[1]
    similar = [c for c in corrections if set(map(normalise, c.hints)) & set(hints)]
    for correction in similar:
        if correction.from_node_id in scores:
            scores[correction.from_node_id] *= 0.5
        if correction.to_node_id in corpus:
            lifted = scores.get(correction.to_node_id, 0.0) + CORRECTION_LIFT
            scores[correction.to_node_id] = min(1.0, lifted)
    return scores, matched


def _ranked(scores: Mapping[UUID, float], among: Iterable[UUID] | None = None) -> list[UUID]:
    allowed = set(among) if among is not None else None
    return [
        node_id
        for node_id, _ in sorted(scores.items(), key=lambda kv: (-kv[1], str(kv[0])))
        if allowed is None or node_id in allowed
    ]


def decide(
    moment: Moment,
    nodes: Sequence[Node],
    texts: Mapping[UUID, Sequence[str]],
    *,
    unsorted_id: UUID,
    memory: Memory | None = None,
    corrections: Sequence[Correction] = (),
    sticky_id: UUID | None = None,
) -> Decision:
    """Where an unspoken moment goes. Never a node the student doesn't have (except their own
    Unsorted notebook, which their device makes), and never a new notebook without a tap."""
    live = {n.id: n for n in nodes if not n.deleted}

    # 1. Source memory, including the student's own moves.
    if memory and memory.node_id in live:
        return Decision("source_memory", memory.node_id, 1.0)

    scores, matched = content_scores(
        moment, [n for n in live.values() if n.id != unsorted_id], texts, corrections
    )
    ranked = _ranked(scores)

    # 2. A concept the moment is about, specific to one place.
    if ranked:
        best = ranked[0]
        second = scores[ranked[1]] if len(ranked) > 1 else 0.0
        if scores[best] >= CONTENT_THRESHOLD and scores[best] - second >= CONTENT_MARGIN:
            return Decision("content_match", best, round(scores[best], 3), matched.get(best))

    # 3. The notebook for its subject, with its likeliest chapters as chips.
    roots = [n for n in live.values() if n.parent_id is None and n.id != unsorted_id]
    if moment.subject and moment.subject != "other":
        same = [n for n in roots if subject_of(n) == moment.subject]
        if same:
            notebook = max(
                same, key=lambda n: (_subtree_score(n.id, live, scores), -roots.index(n))
            )
            children = [n for n in live.values() if n.parent_id == notebook.id]
            likely = _ranked(scores, (c.id for c in children))
            rest = [c.id for c in sorted(children, key=lambda c: c.position) if c.id not in likely]
            return Decision(
                "subject_match", notebook.id, 0.6, alternatives=[*likely, *rest][:MAX_ALTERNATIVES]
            )

    # 4. Where this source's moments went in the last two hours.
    if sticky_id is not None and sticky_id in live:
        return Decision("sticky", sticky_id, 0.5)

    # 5. Unsorted: "Where should this go?", with places to tap and maybe a notebook to start.
    has_subject = moment.subject and any(subject_of(n) == moment.subject for n in roots)
    name = SUBJECT_NAMES.get(moment.subject or "")
    return Decision(
        "unsorted",
        unsorted_id,
        0.0,
        alternatives=ranked[:MAX_ALTERNATIVES],
        new_notebook=None if has_subject or not name else name,
    )


def _subtree_score(root: UUID, live: Mapping[UUID, Node], scores: Mapping[UUID, float]) -> float:
    """The best content score anywhere in a notebook (to choose between two of one subject)."""
    inside = {root}
    changed = True
    while changed:
        changed = False
        for node in live.values():
            if node.parent_id in inside and node.id not in inside:
                inside.add(node.id)
                changed = True
    return max((scores.get(n, 0.0) for n in inside), default=0.0)


def path_of(node_id: UUID, nodes: Sequence[Node]) -> list[str]:
    """Titles from the notebook down ("Physics", "Chapter 3 · Kinematics")."""
    by_id = {n.id: n for n in nodes}
    path: list[str] = []
    current = by_id.get(node_id)
    while current is not None and len(path) < 3:
        path.insert(0, current.title)
        current = by_id.get(current.parent_id) if current.parent_id else None
    return path


def unsorted_node_id(user: str) -> UUID:
    """The student's Unsorted notebook (mirrors `unsortedNodeId` in moments.ts)."""
    words = []
    for seed in (0x811C9DC5, 0x01000193, 0x5BD1E995, 0x27D4EB2F):
        value = seed
        for ch in f"unsorted:{user}":
            value ^= ord(ch)
            value = (value * 0x01000193) & 0xFFFFFFFF
        words.append(f"{value:08x}")
    hexed = list("".join(words))
    hexed[12] = "8"
    hexed[16] = "89ab"[int(hexed[16], 16) & 3]
    return UUID("".join(hexed))
