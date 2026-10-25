"""Where note lines live: Supabase (public.note_lines), or, in local development mode, this
process's memory. Both write lines (sync, N1) and search them (`NoteSearch`, N2).

Supabase is used two ways, like the other stores: with the student's Clerk token (the browser's
syncs and checks; RLS applies), or with the secret key for a check from the desktop app, after
its device token was verified. Every query filters on user_id either way.
"""

import itertools
import math
import re
import threading
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from typing import Any, Protocol
from uuid import UUID

from ..supabase_rest import SupabaseRest, vector_literal
from .embedding import LineEmbeddings, StoredLine
from .models import NotebookRef, NoteLineUpsert, NotePageSync
from .retrieval import Hit, NotebookInfo, NoteSearch, PageInfo, StoredNoteLine


class NoteLineStore(Protocol):
    def stored_lines(self, user: str, page_id: UUID) -> dict[UUID, StoredLine]:
        """The page's lines as the server has them."""
        ...

    def sync(
        self, user: str, page_id: UUID, sync: NotePageSync, embeddings: LineEmbeddings
    ) -> None:
        """Applies one page's changes (and mirrors its notebook and page) atomically."""
        ...

    def delete_all(self, user: str) -> None:
        """Removes every line of the user's (the notes_index setting was turned off)."""
        ...


class NoteStore(NoteLineStore, NoteSearch, Protocol):
    """Writing and searching: what both implementations offer."""


# ─── Local mode ──────────────────────────────────────────────────────────────────────────────


@dataclass
class MemoryLine:
    page_id: UUID
    line: NoteLineUpsert
    embedding: list[float] | None
    embedding_model: str | None
    #: Order of the last change (stands in for updated_at).
    changed: int = 0


@dataclass
class _UserNotes:
    notebooks: dict[UUID, NotebookRef]
    #: page id -> (notebook id, page index)
    pages: dict[UUID, tuple[UUID, int]]
    lines: dict[UUID, MemoryLine]


_WORDS = re.compile(r"[a-z0-9]+")


def _words(text: str) -> set[str]:
    return set(_WORDS.findall(text.lower()))


class MemoryNoteLineStore:
    """Note lines per user in memory (development and evals), with the database's rules: a line
    id that belongs to another page is never moved or overwritten, and searching matches a term
    when the line has all of its words (like plainto_tsquery)."""

    def __init__(self) -> None:
        self._users: dict[str, _UserNotes] = {}
        self._lock = threading.Lock()
        self._clock = itertools.count(1)

    def _of(self, user: str) -> _UserNotes:
        return self._users.setdefault(user, _UserNotes({}, {}, {}))

    # Writing ──────────────────────────────────────────────────────────────────────────────

    def stored_lines(self, user: str, page_id: UUID) -> dict[UUID, StoredLine]:
        with self._lock:
            return {
                line_id: StoredLine(stored.line.text, stored.embedding_model)
                for line_id, stored in self._of(user).lines.items()
                if stored.page_id == page_id
            }

    def sync(
        self, user: str, page_id: UUID, sync: NotePageSync, embeddings: LineEmbeddings
    ) -> None:
        with self._lock:
            notes = self._of(user)
            notes.notebooks[sync.notebook.id] = sync.notebook
            notebook_id, _ = notes.pages.get(page_id, (sync.notebook.id, sync.page_index))
            if notebook_id == sync.notebook.id:
                notes.pages[page_id] = (notebook_id, sync.page_index)
            for line_id in sync.remove:
                if (stored := notes.lines.get(line_id)) and stored.page_id == page_id:
                    del notes.lines[line_id]
            for line in sync.upsert:
                previous = notes.lines.get(line.id)
                if previous is not None and previous.page_id != page_id:
                    continue
                if line.id in embeddings.kept and previous is not None:
                    embedding, model = previous.embedding, previous.embedding_model
                else:
                    embedding = embeddings.vectors.get(line.id)
                    model = embeddings.model if embedding is not None else None
                notes.lines[line.id] = MemoryLine(
                    page_id, line, embedding, model, next(self._clock)
                )

    def delete_all(self, user: str) -> None:
        with self._lock:
            self._of(user).lines.clear()

    def pages_of(self, user: str, line_ids: Sequence[UUID]) -> dict[UUID, UUID]:
        """Which of these lines are the user's, and the page each is on."""
        with self._lock:
            lines = self._of(user).lines
            return {i: lines[i].page_id for i in line_ids if i in lines}

    def lines_of(self, user: str) -> list[MemoryLine]:
        """Every line of the user's (for tests)."""
        with self._lock:
            return list(self._of(user).lines.values())

    # Searching ────────────────────────────────────────────────────────────────────────────

    def latest_notebook(self, user: str) -> NotebookInfo | None:
        with self._lock:
            notes = self._of(user)
            latest = max(notes.lines.values(), key=lambda s: s.changed, default=None)
            page = latest and notes.pages.get(latest.page_id)
            notebook = page and notes.notebooks.get(page[0])
            return _notebook_info(notebook) if notebook else None

    def notebooks(
        self, user: str, *, ids: Sequence[UUID] | None = None, course: UUID | None = None
    ) -> list[NotebookInfo]:
        with self._lock:
            return [
                _notebook_info(n)
                for n in self._of(user).notebooks.values()
                if (ids is None or n.id in ids) and (course is None or n.course_id == course)
            ]

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
        with self._lock:
            notes = self._of(user)
            scoped = [
                s
                for s in notes.lines.values()
                if (notebooks is None or notes.pages.get(s.page_id, (None, 0))[0] in notebooks)
                and (exclude_clip is None or s.line.clip_id != exclude_clip)
            ]
        count = min(max(count, 1), 100)
        similarity: dict[UUID, float] = {}
        if query is not None:
            near = [
                (s.line.id, _cosine(query, s.embedding))
                for s in scoped
                if s.embedding is not None and s.embedding_model == model
            ]
            similarity = dict(sorted(near, key=lambda pair: -pair[1])[:count])
        term_words = [w for w in (_words(t) for t in terms[:40]) if w]
        ranks: dict[UUID, float] = {}
        for stored in scoped:
            matched = sum(1 for words in term_words if words <= _words(stored.line.text))
            if matched:
                ranks[stored.line.id] = float(matched)
        word_rank = dict(sorted(ranks.items(), key=lambda pair: -pair[1])[:count])
        return [
            Hit(
                s.line.id,
                s.page_id,
                s.line.line_index,
                similarity.get(s.line.id),
                word_rank.get(s.line.id),
            )
            for s in scoped
            if s.line.id in similarity or s.line.id in word_rank
        ]

    def page_lines(self, user: str, page_ids: Sequence[UUID]) -> list[StoredNoteLine]:
        with self._lock:
            lines = [s for s in self._of(user).lines.values() if s.page_id in page_ids]
        return sorted((_stored(s.page_id, s.line) for s in lines), key=lambda line: line.line_index)

    def pages(self, user: str, page_ids: Sequence[UUID]) -> list[PageInfo]:
        with self._lock:
            pages = self._of(user).pages
            return [PageInfo(p, pages[p][0], pages[p][1]) for p in page_ids if p in pages]


def _notebook_info(notebook: NotebookRef) -> NotebookInfo:
    return NotebookInfo(notebook.id, notebook.title, notebook.course_id)


def _stored(page_id: UUID, line: NoteLineUpsert) -> StoredNoteLine:
    return StoredNoteLine(
        id=line.id,
        page_id=page_id,
        line_index=line.line_index,
        bbox=line.bbox,
        source=line.source,
        clip_id=line.clip_id,
        text=line.text,
        latex=line.latex,
        confidence=line.confidence,
    )


def _cosine(a: Sequence[float], b: Sequence[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b, strict=False))
    norm = math.sqrt(sum(x * x for x in a)) * math.sqrt(sum(y * y for y in b))
    return dot / norm if norm else 0.0


# ─── Supabase ────────────────────────────────────────────────────────────────────────────────

_LINE_FIELDS = "id,page_id,line_index,bbox,source,clip_id,text,latex,recognition_confidence"


class SupabaseNoteLineStore(SupabaseRest):
    """Note lines through PostgREST: with the student's Clerk token (RLS and the notes_index
    setting are enforced by the database), or with the secret key for the desktop app's checks
    (after its device token was verified; reads only, always filtered on the device's owner)."""

    # Writing ──────────────────────────────────────────────────────────────────────────────

    def stored_lines(self, user: str, page_id: UUID) -> dict[UUID, StoredLine]:
        rows = self._get(
            "note_lines",
            {
                "select": "id,text,embedding_model",
                "user_id": f"eq.{user}",
                "page_id": f"eq.{page_id}",
            },
        )
        return {UUID(r["id"]): StoredLine(r["text"], r.get("embedding_model")) for r in rows}

    def sync(
        self, user: str, page_id: UUID, sync: NotePageSync, embeddings: LineEmbeddings
    ) -> None:
        if self.service:
            raise PermissionError("note lines are only written by their owner")
        notebook = sync.notebook
        self._request(
            "POST",
            "/rest/v1/rpc/sync_note_page",
            json={
                "p_page": str(page_id),
                "p_notebook": {
                    "id": str(notebook.id),
                    "title": notebook.title,
                    "course_id": str(notebook.course_id) if notebook.course_id else None,
                },
                "p_index": sync.page_index,
                "p_lines": [_line_argument(line, embeddings) for line in sync.upsert],
                "p_removed": [str(line_id) for line_id in sync.remove],
            },
        )

    def delete_all(self, user: str) -> None:
        self._delete("note_lines", {"user_id": f"eq.{user}"})

    # Searching ────────────────────────────────────────────────────────────────────────────

    def latest_notebook(self, user: str) -> NotebookInfo | None:
        rows = self._get(
            "note_lines",
            {
                "select": "page_id",
                "user_id": f"eq.{user}",
                "order": "updated_at.desc",
                "limit": "1",
            },
        )
        if not rows:
            return None
        pages = self.pages(user, [UUID(rows[0]["page_id"])])
        found = pages and self.notebooks(user, ids=[pages[0].notebook_id])
        return found[0] if found else None

    def notebooks(
        self, user: str, *, ids: Sequence[UUID] | None = None, course: UUID | None = None
    ) -> list[NotebookInfo]:
        params = {"select": "id,title,course_id,parent_id,root_id", "user_id": f"eq.{user}"}
        if ids is not None:
            if not ids:
                return []
            params["id"] = f"in.({_ids(ids)})"
        if course is not None:
            params["course_id"] = f"eq.{course}"
        return [
            NotebookInfo(
                UUID(r["id"]),
                r["title"],
                _uuid(r.get("course_id")),
                parent_id=_uuid(r.get("parent_id")),
                root_id=_uuid(r.get("root_id")),
            )
            for r in self._get("notebooks", params)
        ]

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
        rows = self._request(
            "POST",
            "/rest/v1/rpc/match_note_lines",
            json={
                "p_user": user,
                "p_query": vector_literal(query) if query is not None else None,
                "p_model": model,
                "p_terms": list(terms),
                "p_notebooks": [str(n) for n in notebooks] if notebooks is not None else None,
                "p_exclude_clip": str(exclude_clip) if exclude_clip else None,
                "p_count": count,
            },
        ).json()
        return [
            Hit(
                UUID(r["id"]),
                UUID(r["page_id"]),
                int(r["line_index"]),
                _number(r.get("similarity")),
                _number(r.get("word_rank")),
            )
            for r in rows
        ]

    def page_lines(self, user: str, page_ids: Sequence[UUID]) -> list[StoredNoteLine]:
        if not page_ids:
            return []
        rows = self._get(
            "note_lines",
            {
                "select": _LINE_FIELDS,
                "user_id": f"eq.{user}",
                "page_id": f"in.({_ids(page_ids)})",
                "order": "line_index",
            },
        )
        return [
            StoredNoteLine(
                id=UUID(r["id"]),
                page_id=UUID(r["page_id"]),
                line_index=int(r["line_index"]),
                bbox=(r["bbox"][0], r["bbox"][1], r["bbox"][2], r["bbox"][3]),
                source=r["source"],
                clip_id=UUID(r["clip_id"]) if r.get("clip_id") else None,
                text=r["text"],
                latex=r.get("latex"),
                confidence=float(r["recognition_confidence"]),
            )
            for r in rows
        ]

    def pages(self, user: str, page_ids: Sequence[UUID]) -> list[PageInfo]:
        if not page_ids:
            return []
        rows = self._get(
            "pages",
            {
                "select": "id,notebook_id,index",
                "user_id": f"eq.{user}",
                "id": f"in.({_ids(page_ids)})",
            },
        )
        return [PageInfo(UUID(r["id"]), UUID(r["notebook_id"]), int(r["index"])) for r in rows]


def _line_argument(line: NoteLineUpsert, embeddings: LineEmbeddings) -> dict[str, Any]:
    """One element of sync_note_page's p_lines."""
    vector = embeddings.vectors.get(line.id)
    return {
        "id": str(line.id),
        "line_index": line.line_index,
        "bbox": list(line.bbox),
        "source": line.source,
        "clip_id": str(line.clip_id) if line.clip_id else None,
        "text": line.text,
        "latex": line.latex,
        "confidence": line.confidence,
        "content_hash": line.content_hash,
        "embedding": vector_literal(vector) if vector is not None else None,
        "embedding_model": embeddings.model if vector is not None else None,
        "keep_embedding": line.id in embeddings.kept,
    }


def _uuid(value: object) -> UUID | None:
    return UUID(value) if isinstance(value, str) else None


def _ids(ids: Iterable[UUID]) -> str:
    return ",".join(str(i) for i in ids)


def _number(value: object) -> float | None:
    return float(value) if isinstance(value, int | float) else None
