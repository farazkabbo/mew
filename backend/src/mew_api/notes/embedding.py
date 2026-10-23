"""Which synced lines need a new embedding, and making them.

Lines are synced every time a page changes, but most of a page's lines keep their text (they
were renumbered or moved, or a neighbour changed). Only lines whose text is new, or that were
embedded by another model (or not at all), are embedded again: that's the cost-control rule.
"""

import logging
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from uuid import UUID

from ..courses.embeddings import Embedder
from .models import NoteLineUpsert

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class StoredLine:
    """What the server already has for a line: enough to decide whether to embed it again."""

    text: str
    embedding_model: str | None


@dataclass(frozen=True)
class LineEmbeddings:
    model: str
    #: New embeddings, by line id.
    vectors: Mapping[UUID, list[float]]
    #: Lines whose text didn't change: their stored embedding stays.
    kept: frozenset[UUID]


def embed_changed_lines(
    lines: Sequence[NoteLineUpsert], stored: Mapping[UUID, StoredLine], embedder: Embedder
) -> LineEmbeddings:
    """Embeds the lines whose text changed, in one batch. If embedding fails, the lines are
    still saved (searchable by word) and embedded on a later sync."""
    kept = frozenset(
        line.id
        for line in lines
        if (known := stored.get(line.id)) is not None
        and known.text == line.text
        and known.embedding_model == embedder.model
    )
    changed = [line for line in lines if line.id not in kept]
    if not changed:
        return LineEmbeddings(embedder.model, {}, kept)
    try:
        vectors = embedder.embed_documents([(None, line.text) for line in changed])
    except Exception as error:  # any failure: keep the text now, embed on the next sync
        logger.warning("Embedding %d note lines failed (%s)", len(changed), type(error).__name__)
        return LineEmbeddings(embedder.model, {}, kept)
    return LineEmbeddings(
        embedder.model,
        {line.id: vector for line, vector in zip(changed, vectors, strict=True)},
        kept,
    )
