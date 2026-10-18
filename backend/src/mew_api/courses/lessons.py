"""Lessons per concept: explanation, worked example and practice questions, generated on demand
from the course material and cached on the concept."""

import logging
from typing import Annotated

from pydantic import BaseModel, Field, StringConstraints

from .llm import GeminiLlm, LlmError
from .models import Concept, Lesson, PracticeQuestion, RetrievedChunk, clipped, first
from .prompts import LESSON

logger = logging.getLogger(__name__)


class _GeneratedLesson(BaseModel):
    """What the model must return: every part required (defaults would let it skip them)."""

    explanation: Annotated[str, clipped(2400), StringConstraints(min_length=1, max_length=2400)]
    worked_example: Annotated[str, clipped(2400), StringConstraints(max_length=2400)]
    practice: Annotated[list[PracticeQuestion], first(5), Field(min_length=1, max_length=5)]
    pages: Annotated[list[int], first(20), Field(max_length=20)]


def generate_lesson(
    concept: Concept, excerpts: list[RetrievedChunk], llm: GeminiLlm | None, model: str
) -> Lesson:
    material = (
        "\n\n".join(f"[p.{e.page}] {e.heading or ''}\n{e.text}" for e in excerpts)
        or "(no excerpts)"
    )
    if llm is not None:
        try:
            lesson = llm.structured(
                model=model,
                system=LESSON.system,
                text=(
                    f"Concept: {concept.title}\nSummary: {concept.summary}\n\n"
                    f"Course material:\n{material}"
                ),
                schema=_GeneratedLesson,
                thinking="low",
                max_tokens=4000,
            )
            valid_pages = {e.page for e in excerpts} | set(concept.source_pages)
            pages = [p for p in lesson.pages if p in valid_pages]
            return Lesson(
                explanation=lesson.explanation,
                worked_example=lesson.worked_example,
                practice=lesson.practice,
                pages=pages,
                generated=True,
            )
        except LlmError as error:
            logger.warning("Lesson generation fell back to excerpts: %s", error)
    return fallback_lesson(concept, excerpts)


def fallback_lesson(concept: Concept, excerpts: list[RetrievedChunk]) -> Lesson:
    """Without a model: the concept summary and the most relevant passage, with its page."""
    best = excerpts[0] if excerpts else None
    explanation = concept.summary or concept.title
    if best:
        explanation = f"{explanation}\n\nFrom p. {best.page}: {best.text[:1200]}"
    return Lesson(
        explanation=explanation[:2400],
        worked_example="",
        practice=[],
        # Cite what is shown: the concept's own pages and the quoted passage, not every hit.
        pages=sorted(set(concept.source_pages) | ({best.page} if best else set()))[:20],
        generated=False,
    )
