"""Retrieval eval for Notes Check (N2 acceptance: the right note lines are retrieved for at least
90% of cases). Each case's notes are synced into a fresh local store next to the shared
distractor notebooks, then the production `retrieve` runs on the case's screen.

    uv run --frozen python -m mew_api.notes.eval_retrieval ../frontend/evals/notes-check

Uses Gemini embeddings when GEMINI_API_KEY is set, hashed-word embeddings otherwise. Prints
counts and case ids only (the cases are test data, but the habit stays: no text in logs).
"""

import json
import sys
import time
import uuid
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ..config import Settings
from ..courses.embeddings import Embedder, GeminiEmbedder, LexicalEmbedder
from .embedding import embed_changed_lines
from .models import (
    NotebookRef,
    NoteLineUpsert,
    NotePageSync,
    RetrieveRequest,
    RetrieveScope,
    ScreenBlock,
)
from .retrieval import retrieve
from .store import MemoryNoteLineStore

USER = "eval"
_NAMESPACE = uuid.UUID("6d1f3c2a-8a40-4b39-9c51-0f1e5b6d7a10")


def stable_id(*parts: str) -> uuid.UUID:
    """The same UUID for the same case and line every run."""
    return uuid.uuid5(_NAMESPACE, "/".join(parts))


class CachingEmbedder:
    """Embeds each distinct text once per run (the distractors are shared by every case), and
    paces calls at `pace_s` seconds per text embedded (free API tiers count each text against a
    per-minute limit). Counts failures, so a run that fell back to words alone says so."""

    def __init__(self, inner: Embedder, pace_s: float = 0.0) -> None:
        self.inner = inner
        self.model = inner.model
        self.pace_s = pace_s
        self.failures = 0
        self._documents: dict[str, list[float]] = {}
        self._next_call = 0.0

    def embed_documents(self, texts: Sequence[tuple[str | None, str]]) -> list[list[float]]:
        missing = [t for t in dict.fromkeys(texts) if t[1] not in self._documents]
        if missing:
            vectors = self._paced(len(missing), lambda: self.inner.embed_documents(missing))
            for (_, text), vector in zip(missing, vectors, strict=True):
                self._documents[text] = vector
        return [self._documents[text] for _, text in texts]

    def embed_query(self, text: str) -> list[float]:
        return self._paced(1, lambda: self.inner.embed_query(text))

    def _paced[T](self, texts: int, call: Callable[[], T]) -> T:
        delay = self._next_call - time.monotonic()
        if delay > 0:
            time.sleep(delay)
        self._next_call = time.monotonic() + self.pace_s * texts
        try:
            return call()
        except Exception:
            self.failures += 1
            raise


@dataclass(frozen=True)
class CaseResult:
    case_id: str
    #: Every relevant line was retrieved.
    found_all: bool
    recall: float
    lines: int
    distractor_lines: int
    related: bool


def load(directory: Path) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    cases = json.loads((directory / "cases.json").read_text(encoding="utf-8"))
    distractors = json.loads((directory / "distractors.json").read_text(encoding="utf-8"))
    return cases, distractors


def _sync(
    store: MemoryNoteLineStore,
    embedder: Embedder,
    notebook: NotebookRef,
    page_id: uuid.UUID,
    page_index: int,
    lines: list[NoteLineUpsert],
) -> None:
    sync = NotePageSync(notebook=notebook, page_index=page_index, upsert=lines, remove=[])
    embeddings = embed_changed_lines(lines, {}, embedder)
    store.sync(USER, page_id, sync, embeddings)


def _line(line_id: uuid.UUID, index: int, text: str, **extra: Any) -> NoteLineUpsert:
    return NoteLineUpsert(
        id=line_id,
        line_index=index,
        bbox=(10, 20 + 30 * index, 300, 24),
        source=extra.get("source", "ink"),
        clip_id=stable_id("clip", str(line_id)) if extra.get("source") == "clip" else None,
        text=text,
        latex=extra.get("latex"),
        confidence=extra.get("confidence", 0.92),
        content_hash="0a1b2c3d",
    )


def corpus(
    case: dict[str, Any], distractors: list[dict[str, Any]], embedder: Embedder
) -> MemoryNoteLineStore:
    """A store holding the distractor notebooks and the case's own notebook."""
    store = MemoryNoteLineStore()
    for notebook in distractors:
        ref = NotebookRef(
            id=stable_id("d", notebook["title"]), title=notebook["title"], course_id=None
        )
        for index, page in enumerate(notebook["pages"]):
            page_id = stable_id("d", notebook["title"], str(index))
            lines = [_line(stable_id(str(page_id), str(i)), i, text) for i, text in enumerate(page)]
            _sync(store, embedder, ref, page_id, index, lines)

    ref = NotebookRef(id=stable_id(case["id"]), title=case["subject"].title(), course_id=None)
    pages: dict[int, list[dict[str, Any]]] = {}
    for note in case["notes"]:
        pages.setdefault(note.get("page", 1), []).append(note)
    for number, notes in sorted(pages.items()):
        page_id = stable_id(case["id"], "page", str(number))
        lines = [
            _line(
                stable_id(case["id"], note["lineId"]),
                i,
                note["text"],
                **{k: note[k] for k in ("source", "latex", "confidence") if k in note},
            )
            for i, note in enumerate(notes)
        ]
        _sync(store, embedder, ref, page_id, number - 1, lines)
    return store


def run_case(
    case: dict[str, Any], distractors: list[dict[str, Any]], embedder: Embedder
) -> CaseResult:
    store = corpus(case, distractors, embedder)
    request = RetrieveRequest(
        screen=[ScreenBlock(block_id=b["blockId"], text=b["text"]) for b in case["screen"]],
        scope=RetrieveScope(kind="all"),
    )
    response = retrieve(store, embedder, USER, request)
    own = {stable_id(case["id"], n["lineId"]): n for n in case["notes"]}
    relevant = {line_id for line_id, n in own.items() if not n.get("offTopic")}
    retrieved = {line.line_id for line in response.lines}
    found = relevant & retrieved
    return CaseResult(
        case_id=case["id"],
        found_all=found == relevant,
        recall=len(found) / len(relevant) if relevant else 1.0,
        lines=len(retrieved),
        distractor_lines=len(retrieved - set(own)),
        related=response.related,
    )


def run(directory: Path, embedder: Embedder, pace_s: float = 0.0) -> tuple[list[CaseResult], int]:
    """Every case's result, and how many embedding calls failed (words alone were used then)."""
    cases, distractors = load(directory)
    cached = CachingEmbedder(embedder, pace_s)
    return [run_case(case, distractors, cached) for case in cases], cached.failures


def summary(results: Sequence[CaseResult]) -> dict[str, float]:
    n = len(results) or 1
    return {
        "cases": len(results),
        "found_all_rate": sum(r.found_all for r in results) / n,
        "mean_recall": sum(r.recall for r in results) / n,
        "mean_lines": sum(r.lines for r in results) / n,
        "mean_distractor_lines": sum(r.distractor_lines for r in results) / n,
    }


def main(argv: Sequence[str]) -> int:
    directory = Path(argv[0]) if argv else Path("../frontend/evals/notes-check")
    settings = Settings()
    embedder: Embedder
    pace_s = 0.0
    if settings.gemini_api_key is not None:
        from google import genai

        client = genai.Client(api_key=settings.gemini_api_key.get_secret_value())
        embedder = GeminiEmbedder(client, settings.gemini_embed_model)
        pace_s = 0.7
    else:
        embedder = LexicalEmbedder()
    results, failures = run(directory, embedder, pace_s)
    for result in results:
        if not result.found_all:
            print(f"MISSED {result.case_id}: recall {result.recall:.2f}")
    stats = summary(results)
    print(f"embedder {embedder.model}: " + ", ".join(f"{k} {v:.2f}" for k, v in stats.items()))
    if failures:
        print(f"WARNING: {failures} embedding calls failed; those cases used words only")
    return 0 if stats["found_all_rate"] >= 0.9 and not failures else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
