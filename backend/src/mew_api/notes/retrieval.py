"""Finding the notes that relate to a screen (Notes Check N2, docs/SCREEN_COACH_NOTES_CHECK.md §5).

1. The screen's text is embedded as one query, and its salient words become search terms (no
   model call: decision 13).
2. The store returns lines found by meaning and/or by word, within the scope.
3. Hits are ranked by reciprocal-rank fusion; a hit counts only if it's similar enough or shares a
   word. Nothing relevant: "no related notes", and the comparison is skipped.
4. The best pages (at most 4) are kept, each hit with its neighbours (±3 lines), at most 120 lines.

Everything here but `retrieve` is pure, so the eval and the tests run exactly this code.
"""

import logging
import re
import time
from collections import defaultdict
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import Protocol
from uuid import UUID

from ..courses.embeddings import LEXICAL_MODEL, STOPWORDS, Embedder
from .models import (
    CoursePassage,
    RetrievedLine,
    RetrievedPage,
    RetrieveRequest,
    RetrieveResponse,
    ScreenBlock,
    UsedScope,
)

logger = logging.getLogger(__name__)

#: Lines taken by meaning and by word, each (brief §5.2).
SEARCH_COUNT = 40
NEIGHBOURS = 3
MAX_PAGES = 4
MAX_LINES = 120
#: A page is kept when its score is at least this share of the best page's (see `best_pages`).
PAGE_SCORE_RATIO = 0.4
MAX_TERMS = 24
QUERY_CHARS = 2000
#: Reciprocal-rank fusion constant (the usual 60).
RRF_K = 60
#: Below this similarity a line found by meaning alone isn't related. Per embedder: hashed words
#: score low even when related; Gemini's embeddings score ~0.5 for text on unrelated topics.
MIN_SIMILARITY: Mapping[str, float] = {LEXICAL_MODEL: 0.15}
DEFAULT_MIN_SIMILARITY = 0.6

#: Words too common in study material to say what a screen is about.
_GENERIC = frozenset(
    [
        "also",
        "about",
        "after",
        "again",
        "because",
        "been",
        "before",
        "being",
        "between",
        "both",
        "could",
        "does",
        "each",
        "example",
        "figure",
        "first",
        "following",
        "from",
        "have",
        "here",
        "however",
        "into",
        "just",
        "like",
        "many",
        "more",
        "most",
        "much",
        "must",
        "only",
        "other",
        "over",
        "same",
        "should",
        "since",
        "some",
        "such",
        "than",
        "their",
        "them",
        "then",
        "there",
        "these",
        "they",
        "thing",
        "this",
        "those",
        "through",
        "under",
        "until",
        "very",
        "well",
        "were",
        "what",
        "when",
        "where",
        "which",
        "while",
        "will",
        "with",
        "would",
        "your",
        "note",
        "notes",
        "page",
        "slide",
        "lecture",
        "chapter",
        "section",
        "table",
    ]
)
_WORD = re.compile(r"[A-Za-z][A-Za-z'-]{2,}|\d+(?:[.,]\d+)?")


@dataclass(frozen=True)
class NotebookInfo:
    """A node of the notebook tree (K1): a notebook, chapter or section."""

    id: UUID
    title: str
    course_id: UUID | None
    parent_id: UUID | None = None
    #: The notebook at the top of its tree (itself for a notebook).
    root_id: UUID | None = None


@dataclass(frozen=True)
class PageInfo:
    id: UUID
    notebook_id: UUID
    index: int


@dataclass(frozen=True)
class Hit:
    line_id: UUID
    page_id: UUID
    line_index: int
    similarity: float | None
    word_rank: float | None


@dataclass(frozen=True)
class StoredNoteLine:
    id: UUID
    page_id: UUID
    line_index: int
    bbox: tuple[float, float, float, float]
    source: str
    clip_id: UUID | None
    text: str
    latex: str | None
    confidence: float


class NoteSearch(Protocol):
    """What retrieval needs from a store (notes.store has the memory and Supabase ones)."""

    def latest_notebook(self, user: str) -> NotebookInfo | None:
        """The notebook the student is working in: the one whose lines changed last."""
        ...

    def notebooks(
        self, user: str, *, ids: Sequence[UUID] | None = None, course: UUID | None = None
    ) -> list[NotebookInfo]:
        """The user's nodes: all of them, those in `ids`, or those linked to `course`."""
        ...

    def search(
        self,
        user: str,
        query: list[float] | None,
        model: str,
        terms: Sequence[str],
        notebooks: Sequence[UUID] | None,
        count: int,
        exclude_clip: UUID | None = None,
    ) -> list[Hit]:
        """Lines found by meaning (when `query` is given) and/or by word, within the notebooks
        (None: all of them), leaving out the lines of `exclude_clip`."""
        ...

    def page_lines(self, user: str, page_ids: Sequence[UUID]) -> list[StoredNoteLine]: ...

    def pages(self, user: str, page_ids: Sequence[UUID]) -> list[PageInfo]: ...


# ─── Pure parts ──────────────────────────────────────────────────────────────────────────────


def screen_query(blocks: Sequence[ScreenBlock]) -> str:
    """The screen's text as one query for the embedder."""
    return " \n".join(b.text for b in blocks)[:QUERY_CHARS]


def search_terms(blocks: Sequence[ScreenBlock]) -> list[str]:
    """The screen's salient words, most frequent first: no common words, numbers with two or
    more digits (dates, values) kept."""
    counts: dict[str, int] = defaultdict(int)
    first_seen: dict[str, int] = {}
    for word in _WORD.findall(" ".join(b.text for b in blocks)):
        term = word.lower().strip("'-")
        if term[0].isdigit():
            if len(re.sub(r"\D", "", term)) < 2:
                continue
        elif len(term) < 4 or term in STOPWORDS or term in _GENERIC:
            continue
        counts[term] += 1
        first_seen.setdefault(term, len(first_seen))
    ranked = sorted(counts, key=lambda t: (-counts[t], first_seen[t]))
    return ranked[:MAX_TERMS]


def is_related(hit: Hit, model: str) -> bool:
    """A hit counts when it shares a word with the screen or is similar enough in meaning."""
    if hit.word_rank is not None and hit.word_rank > 0:
        return True
    threshold = MIN_SIMILARITY.get(model, DEFAULT_MIN_SIMILARITY)
    return hit.similarity is not None and hit.similarity >= threshold


def rank_hits(hits: Sequence[Hit], model: str) -> list[tuple[Hit, float]]:
    """Related hits, best first, scored by reciprocal-rank fusion of the two searches."""
    related = [h for h in hits if is_related(h, model)]
    by_meaning = sorted(
        (h for h in related if h.similarity is not None), key=lambda h: -(h.similarity or 0)
    )
    by_word = sorted(
        (h for h in related if h.word_rank is not None), key=lambda h: -(h.word_rank or 0)
    )
    score: dict[UUID, float] = defaultdict(float)
    for ranking in (by_meaning, by_word):
        for rank, hit in enumerate(ranking):
            score[hit.line_id] += 1 / (RRF_K + rank + 1)
    return sorted(((h, score[h.line_id]) for h in related), key=lambda pair: -pair[1])


#: How much more a hit counts in the open chapter, then in its notebook, than elsewhere.
NEAR_BOOSTS = (1.5, 1.2)


def prefer_near(
    ranked: Sequence[tuple[Hit, float]],
    notebook_of_page: dict[UUID, UUID],
    ladder: Sequence[UsedScope],
) -> list[tuple[Hit, float]]:
    """`ranked` with the hits in the nearer scopes of `ladder` (all but its last, widest rung)
    counting more, best first again."""
    rungs = [set(scope.notebook_ids) for scope in ladder[:-1]]

    def boosted(hit: Hit, score: float) -> float:
        notebook = notebook_of_page.get(hit.page_id)
        for rung, boost in zip(rungs, NEAR_BOOSTS, strict=False):
            if notebook in rung:
                return score * boost
        return score

    return sorted(((hit, boosted(hit, score)) for hit, score in ranked), key=lambda p: -p[1])


def best_pages(
    ranked: Sequence[tuple[Hit, float]],
    limit: int = MAX_PAGES,
    ratio: float = PAGE_SCORE_RATIO,
) -> list[UUID]:
    """Pages by the summed score of their hits (several hits on a page beat one stray hit),
    keeping only those within `ratio` of the best page: a page with one stray shared word isn't
    sent to the comparison next to the page that's really about the screen."""
    totals: dict[UUID, float] = defaultdict(float)
    for hit, score in ranked[:SEARCH_COUNT]:
        totals[hit.page_id] += score
    ordered = sorted(totals, key=lambda page: -totals[page])
    best = totals[ordered[0]] if ordered else 0.0
    return [page for page in ordered if totals[page] >= best * ratio][:limit]


def select_context(
    ranked: Sequence[tuple[Hit, float]],
    lines: Sequence[StoredNoteLine],
    pages: Sequence[UUID],
    exclude_clip: UUID | None = None,
) -> list[RetrievedLine]:
    """Each hit on the chosen pages with its neighbours, at most MAX_LINES lines (closest to a hit
    first), in page order and then reading order. Lines of `exclude_clip` are never context."""
    hits = {hit.line_id for hit, _ in ranked[:SEARCH_COUNT]}
    page_order = {page: i for i, page in enumerate(pages)}
    by_page: dict[UUID, list[StoredNoteLine]] = defaultdict(list)
    for line in lines:
        if line.page_id in page_order and (exclude_clip is None or line.clip_id != exclude_clip):
            by_page[line.page_id].append(line)

    candidates: list[tuple[int, StoredNoteLine]] = []
    for page_lines in by_page.values():
        hit_indexes = [line.line_index for line in page_lines if line.id in hits]
        for line in page_lines:
            distance = min((abs(line.line_index - i) for i in hit_indexes), default=NEIGHBOURS + 1)
            if distance <= NEIGHBOURS:
                candidates.append((distance, line))
    kept = sorted(candidates, key=lambda c: (c[0], page_order[c[1].page_id]))[:MAX_LINES]
    kept.sort(key=lambda c: (page_order[c[1].page_id], c[1].line_index))
    return [_retrieved(line, hit=line.id in hits) for _, line in kept]


def _retrieved(line: StoredNoteLine, *, hit: bool) -> RetrievedLine:
    return RetrievedLine(
        line_id=line.id,
        page_id=line.page_id,
        line_index=line.line_index,
        bbox=line.bbox,
        source="clip" if line.source == "clip" else "ink",
        clip_id=line.clip_id,
        text=line.text,
        latex=line.latex,
        confidence=line.confidence,
        hit=hit,
    )


# ─── Retrieval ───────────────────────────────────────────────────────────────────────────────

PassageFinder = Callable[[UUID, str], list[CoursePassage]]


def retrieve(
    store: NoteSearch,
    embedder: Embedder,
    user: str,
    request: RetrieveRequest,
    passages: PassageFinder | None = None,
) -> RetrieveResponse:
    """The notes related to the screen, with the course passages on the same topic."""
    started = time.perf_counter()
    ladder = _scope_ladder(store, user, request)
    if not ladder:
        return _nothing(UsedScope(kind="all"))

    query = screen_query(request.screen)
    terms = search_terms(request.screen)
    try:
        vector: list[float] | None = embedder.embed_query(query)
    except Exception as error:  # words alone still find notes
        logger.warning("Embedding the screen failed (%s)", type(error).__name__)
        vector = None
    exclude = request.exclude_clip_id
    # The widest scope is searched (every related line can be found), and the nearest notes
    # rank first: the open chapter's, then its notebook's (section 2.3).
    scope = ladder[-1]
    notebooks = scope.notebook_ids or None
    hits = store.search(user, vector, embedder.model, terms, notebooks, SEARCH_COUNT, exclude)
    ranked = rank_hits(hits, embedder.model)
    if not ranked:
        _log(started, hits, ranked, 0)
        return _nothing(scope)

    infos = {p.id: p for p in store.pages(user, list({hit.page_id for hit, _ in ranked}))}
    ranked = prefer_near(ranked, {page: info.notebook_id for page, info in infos.items()}, ladder)
    pages = best_pages(ranked)
    lines = select_context(ranked, store.page_lines(user, pages), pages, exclude)
    titles = {
        n.id: n.title for n in store.notebooks(user, ids=[p.notebook_id for p in infos.values()])
    }
    found_passages = passages(scope.course_id, query) if passages and scope.course_id else []
    _log(started, hits, ranked, len(lines))
    return RetrieveResponse(
        scope=scope,
        related=True,
        pages=[
            RetrievedPage(
                page_id=page,
                notebook_id=infos[page].notebook_id,
                notebook_title=titles.get(infos[page].notebook_id, "Notes"),
                page_index=infos[page].index,
            )
            for page in pages
            if page in infos
        ],
        lines=lines,
        passages=found_passages,
    )


def _scope_ladder(store: NoteSearch, user: str, request: RetrieveRequest) -> list[UsedScope]:
    """Where to look, closest first (K1, docs/NOTEBOOKS_K.md section 2.3): a node and everything
    under it, then its whole notebook, then the notebook's course. Empty when there's nothing
    to search in."""
    scope = request.scope
    if scope.kind == "all":
        return [UsedScope(kind="all")]
    tree = store.notebooks(user)
    if scope.kind == "course" and scope.course_id is not None:
        course = _course_scope(tree, scope.course_id)
        return [course] if course else []
    if scope.kind == "notebook" and scope.notebook_id is not None:
        start = scope.notebook_id
    else:
        latest = store.latest_notebook(user)
        if latest is None:
            return []
        start = latest.id
    return ladder_from(tree, start)


def ladder_from(tree: Sequence[NotebookInfo], start: UUID) -> list[UsedScope]:
    by_id = {n.id: n for n in tree}
    node = by_id.get(start)
    if node is None:
        return []
    root = by_id.get(node.root_id or node.id, node)
    ladder = [UsedScope(kind="notebook", notebook_ids=_subtree(tree, node.id))]
    if root.id != node.id:
        ladder.append(UsedScope(kind="notebook", notebook_ids=_subtree(tree, root.id)))
    course = _course_scope(tree, root.course_id) if root.course_id else None
    if course:
        ladder.append(course)
    return ladder


def _course_scope(tree: Sequence[NotebookInfo], course_id: UUID) -> UsedScope | None:
    """Every notebook linked to the course, with its chapters and sections (only a notebook
    carries the link)."""
    roots = [n.id for n in tree if n.course_id == course_id]
    ids = [i for root in roots for i in _subtree(tree, root)]
    if not ids:
        return None
    return UsedScope(kind="course", course_id=course_id, notebook_ids=list(dict.fromkeys(ids)))


def _subtree(tree: Sequence[NotebookInfo], top: UUID) -> list[UUID]:
    """`top` and every node under it."""
    ids = [top]
    for parent in ids:  # grows as children are found (three levels at most)
        ids.extend(n.id for n in tree if n.parent_id == parent and n.id not in ids)
    return ids


def _nothing(scope: UsedScope) -> RetrieveResponse:
    return RetrieveResponse(scope=scope, related=False, pages=[], lines=[], passages=[])


def _log(
    started: float, hits: Sequence[Hit], ranked: Sequence[tuple[Hit, float]], lines: int
) -> None:
    """Scores and counts for tuning (brief §5): never text."""
    best = max((h.similarity for h in hits if h.similarity is not None), default=None)
    logger.info(
        "Note retrieval: %d hits, %d related, %d lines, best similarity %s, %d ms",
        len(hits),
        len(ranked),
        lines,
        "-" if best is None else f"{best:.3f}",
        round((time.perf_counter() - started) * 1000),
    )
