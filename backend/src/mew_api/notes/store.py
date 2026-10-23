"""Where note lines live: Supabase (public.note_lines, written through sync_note_page with the
student's own token, so RLS applies), or, in local development mode, this process's memory.
"""

import threading
from dataclasses import dataclass
from typing import Any, Protocol
from uuid import UUID

from ..supabase_rest import SupabaseRest, vector_literal
from .embedding import LineEmbeddings, StoredLine
from .models import NotebookRef, NoteLineUpsert, NotePageSync


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


# ─── Local mode ──────────────────────────────────────────────────────────────────────────────


@dataclass
class MemoryLine:
    page_id: UUID
    line: NoteLineUpsert
    embedding: list[float] | None
    embedding_model: str | None


@dataclass
class _UserNotes:
    notebooks: dict[UUID, NotebookRef]
    #: page id -> (notebook id, page index)
    pages: dict[UUID, tuple[UUID, int]]
    lines: dict[UUID, MemoryLine]


class MemoryNoteLineStore:
    """Note lines per user in memory (development only), with the database's rules: a line id
    that belongs to another page is never moved or overwritten."""

    def __init__(self) -> None:
        self._users: dict[str, _UserNotes] = {}
        self._lock = threading.Lock()

    def _of(self, user: str) -> _UserNotes:
        return self._users.setdefault(user, _UserNotes({}, {}, {}))

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
                notes.lines[line.id] = MemoryLine(page_id, line, embedding, model)

    def delete_all(self, user: str) -> None:
        with self._lock:
            self._of(user).lines.clear()

    def lines_of(self, user: str) -> list[MemoryLine]:
        """Every line of the user's (for retrieval in local mode, and tests)."""
        with self._lock:
            return list(self._of(user).lines.values())


# ─── Supabase ────────────────────────────────────────────────────────────────────────────────


class SupabaseNoteLineStore(SupabaseRest):
    """Note lines through PostgREST with the student's Clerk token: RLS and the notes_index
    setting are enforced by the database."""

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
