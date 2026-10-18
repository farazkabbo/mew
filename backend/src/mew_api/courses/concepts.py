"""The concept graph: what to learn, in what order, with prerequisites and source pages."""

import logging
import re
from typing import Annotated

from pydantic import BaseModel, Field, StringConstraints

from .chunking import TextChunk
from .llm import GeminiLlm, LlmError
from .models import Subject, clipped, first
from .prompts import CONCEPT_GRAPH

logger = logging.getLogger(__name__)

OUTLINE_CHARS = 24_000
MAX_CONCEPTS = 20


class ExtractedConcept(BaseModel):
    title: Annotated[
        str, clipped(120), StringConstraints(strip_whitespace=True, min_length=1, max_length=120)
    ]
    # Required (not defaulted) so the model always fills them in.
    summary: Annotated[str, clipped(600), StringConstraints(max_length=600)]
    pages: Annotated[list[int], first(20), Field(max_length=20)]
    prerequisites: Annotated[list[int], first(8), Field(max_length=8)]


class ConceptGraph(BaseModel):
    subject: Subject = "other"
    concepts: Annotated[list[ExtractedConcept], first(30), Field(min_length=1, max_length=30)]


def outline(chunks: list[TextChunk]) -> str:
    """One line per chunk: page, heading and opening words; capped in length."""
    lines: list[str] = []
    total = 0
    for chunk in chunks:
        opening = re.sub(r"\s+", " ", chunk.text)[:240]
        line = f"[p.{chunk.page}] ({chunk.heading or '-'}) {opening}"
        if total + len(line) > OUTLINE_CHARS:
            break
        lines.append(line)
        total += len(line) + 1
    return "\n".join(lines)


def extract_concepts(
    chunks: list[TextChunk], llm: GeminiLlm | None, model: str, title: str
) -> ConceptGraph:
    """The model's concept graph, cleaned up; the heading-based outline if the model can't help."""
    if llm is not None:
        try:
            graph = llm.structured(
                model=model,
                system=CONCEPT_GRAPH.system,
                text=f"Course title: {title}\n\nOutline:\n{outline(chunks)}",
                schema=ConceptGraph,
                thinking="low",
                max_tokens=6000,
                timeout_s=90,
            )
            return clean(graph, {c.page for c in chunks})
        except LlmError as error:
            logger.warning("Concept extraction fell back to headings: %s", error)
    return heuristic_concepts(chunks)


def clean(graph: ConceptGraph, pages: set[int]) -> ConceptGraph:
    """Drops duplicates and pages that don't exist; keeps prerequisites acyclic (earlier only)."""
    seen: dict[str, int] = {}
    kept: list[ExtractedConcept] = []
    remap: dict[int, int] = {}
    for index, concept in enumerate(graph.concepts[:MAX_CONCEPTS]):
        key = concept.title.casefold()
        if key in seen:
            remap[index] = seen[key]
            continue
        remap[index] = len(kept)
        seen[key] = len(kept)
        prerequisites = sorted(
            {
                remap[p]
                for p in concept.prerequisites
                if p < index and p in remap and remap[p] < len(kept)
            }
        )
        kept.append(
            concept.model_copy(
                update={
                    "pages": sorted({p for p in concept.pages if p in pages})[:20],
                    "prerequisites": prerequisites,
                }
            )
        )
    return ConceptGraph(subject=graph.subject, concepts=kept)


def heuristic_concepts(chunks: list[TextChunk]) -> ConceptGraph:
    """Without a model: one concept per section heading, in order, each building on the last."""
    sections: dict[str, list[TextChunk]] = {}
    for chunk in chunks:
        if chunk.heading:
            sections.setdefault(chunk.heading, []).append(chunk)
    if not sections:
        # No headings: split the material into parts by page.
        size = max(1, len(chunks) // 5)
        for i in range(0, len(chunks), size):
            part = chunks[i : i + size]
            sections[f"Part {i // size + 1} (p. {part[0].page}-{part[-1].page})"] = part
    concepts = []
    for index, (heading, members) in enumerate(list(sections.items())[:MAX_CONCEPTS]):
        first = re.split(r"(?<=[.!?])\s", members[0].text.strip(), maxsplit=1)[0]
        concepts.append(
            ExtractedConcept(
                title=_title(heading),
                summary=first[:300],
                pages=sorted({m.page for m in members})[:20],
                prerequisites=[index - 1] if index > 0 else [],
            )
        )
    return ConceptGraph(subject="other", concepts=concepts)


def _title(heading: str) -> str:
    # "3.2 Newton's laws" → "Newton's laws"; keep "Chapter 4 Energy" readable.
    stripped = re.sub(r"^\d+(?:\.\d+)*\.?\s+", "", heading).strip()
    return (stripped or heading)[:120]
