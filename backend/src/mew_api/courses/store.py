"""Where courses live: Supabase (RLS-scoped, production) or memory (local development mode).

Both implement CourseStore. Every method takes the owner's user id, and every read and write is
scoped to it, so the in-memory store isolates users the same way RLS does.
"""

import math
import threading
import uuid
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import UTC, date, datetime
from typing import Any, Protocol
from uuid import UUID

from ..learner.models import (
    MAX_ATTEMPTS,
    AttemptRecord,
    AttemptWrite,
    CardRecord,
    DueCard,
    FsrsCard,
    LearnerData,
)
from .models import (
    Concept,
    Course,
    Edge,
    Lesson,
    NewChunk,
    NewConcept,
    RetrievedChunk,
    Source,
)


class CourseNotFoundError(LookupError):
    pass


class CourseStore(Protocol):
    def ensure_profile(self, user: str) -> None:
        """Courses belong to a profile row; create it on first use."""
        ...

    def create_course(self, user: str, title: str) -> Course: ...
    def list_courses(self, user: str) -> list[Course]: ...
    def get_course(self, user: str, course_id: UUID) -> Course | None: ...
    def update_course(self, user: str, course_id: UUID, fields: dict[str, Any]) -> None: ...
    def delete_course(self, user: str, course_id: UUID) -> None: ...

    def add_source(self, user: str, source: Source) -> None: ...
    def list_sources(self, user: str, course_id: UUID) -> list[Source]: ...
    def upload(self, user: str, path: str, data: bytes) -> None: ...

    def add_chunks(
        self, user: str, course_id: UUID, source_id: UUID, chunks: Sequence[NewChunk]
    ) -> list[UUID]: ...
    def match_chunks(
        self, user: str, course_id: UUID, embedding: list[float], k: int
    ) -> list[RetrievedChunk]: ...
    def chunk_ids_on_pages(self, user: str, course_id: UUID, pages: list[int]) -> list[UUID]: ...

    def add_concepts(
        self, user: str, course_id: UUID, concepts: Sequence[NewConcept]
    ) -> list[UUID]: ...
    def list_concepts(self, user: str, course_id: UUID) -> list[Concept]: ...
    def update_concept(self, user: str, concept_id: UUID, fields: dict[str, Any]) -> None: ...
    def delete_concepts(self, user: str, concept_ids: Sequence[UUID]) -> None: ...
    def add_edges(self, user: str, edges: Sequence[Edge]) -> None: ...
    def list_edges(self, user: str, course_id: UUID) -> list[Edge]: ...
    def set_edges(self, user: str, course_id: UUID, edges: Sequence[Edge]) -> None: ...
    def add_concept_sources(self, user: str, links: Sequence[tuple[UUID, UUID]]) -> None: ...

    # Learner model (M8)
    def has_concept(self, user: str, course_id: UUID, concept_id: UUID) -> bool: ...
    def learner_data(self, user: str, course_id: UUID) -> LearnerData: ...
    def add_attempt(self, user: str, course_id: UUID, attempt: AttemptWrite) -> None:
        """Logs the attempt and saves the concept's rescheduled card."""
        ...

    def start_card(self, user: str, course_id: UUID, concept_id: UUID, card: FsrsCard) -> None:
        """Creates the concept's card unless it already has one."""
        ...

    def due_cards(self, user: str, before: datetime, limit: int) -> list[DueCard]: ...


# ─── In memory (local development mode) ──────────────────────────────────────────────────────


@dataclass
class _Chunk:
    id: UUID
    course_id: UUID
    source_id: UUID
    page: int
    heading: str | None
    text: str
    embedding: list[float]
    notebook_node_id: UUID | None = None


@dataclass
class _UserData:
    courses: dict[UUID, Course] = field(default_factory=dict)
    sources: dict[UUID, Source] = field(default_factory=dict)
    chunks: dict[UUID, _Chunk] = field(default_factory=dict)
    concepts: dict[UUID, Concept] = field(default_factory=dict)
    edges: set[tuple[UUID, UUID]] = field(default_factory=set)
    concept_sources: set[tuple[UUID, UUID]] = field(default_factory=set)
    files: dict[str, bytes] = field(default_factory=dict)
    attempts: list[tuple[UUID, AttemptRecord]] = field(default_factory=list)  # (course, attempt)
    cards: dict[UUID, tuple[UUID, CardRecord]] = field(default_factory=dict)  # concept → card


MAX_LOCAL_COURSES = 20
#: Attempts kept per local user (the oldest go first).
MAX_LOCAL_ATTEMPTS = 20_000


class MemoryCourseStore:
    """Courses for local mode, kept in this process (lost on restart, like a scratch pad)."""

    def __init__(self) -> None:
        self._users: dict[str, _UserData] = {}
        self._lock = threading.RLock()

    def _data(self, user: str) -> _UserData:
        return self._users.setdefault(user, _UserData())

    def ensure_profile(self, user: str) -> None:
        pass

    def create_course(self, user: str, title: str) -> Course:
        with self._lock:
            data = self._data(user)
            if len(data.courses) >= MAX_LOCAL_COURSES:
                raise ValueError("too many courses")
            course = Course(
                id=uuid.uuid4(), title=title, status="processing", created_at=datetime.now(UTC)
            )
            data.courses[course.id] = course
            return course

    def list_courses(self, user: str) -> list[Course]:
        with self._lock:
            return sorted(
                self._data(user).courses.values(), key=lambda c: c.created_at, reverse=True
            )

    def get_course(self, user: str, course_id: UUID) -> Course | None:
        with self._lock:
            return self._data(user).courses.get(course_id)

    def update_course(self, user: str, course_id: UUID, fields: dict[str, Any]) -> None:
        with self._lock:
            data = self._data(user)
            course = data.courses.get(course_id)
            if course is None:
                raise CourseNotFoundError(course_id)
            if isinstance(fields.get("exam_date"), str):
                fields = {**fields, "exam_date": date.fromisoformat(fields["exam_date"])}
            data.courses[course_id] = course.model_copy(update=fields)

    def delete_course(self, user: str, course_id: UUID) -> None:
        with self._lock:
            data = self._data(user)
            data.courses.pop(course_id, None)
            for source in [s for s in data.sources.values() if s.course_id == course_id]:
                data.sources.pop(source.id)
                if source.storage_path:
                    data.files.pop(source.storage_path, None)
            data.chunks = {k: c for k, c in data.chunks.items() if c.course_id != course_id}
            gone = {c.id for c in data.concepts.values() if c.course_id == course_id}
            data.concepts = {k: c for k, c in data.concepts.items() if k not in gone}
            data.edges = {e for e in data.edges if e[0] not in gone and e[1] not in gone}
            self._forget_learning(data, gone)

    def add_source(self, user: str, source: Source) -> None:
        with self._lock:
            self._require(user, source.course_id)
            self._data(user).sources[source.id] = source

    def list_sources(self, user: str, course_id: UUID) -> list[Source]:
        with self._lock:
            return [s for s in self._data(user).sources.values() if s.course_id == course_id]

    def upload(self, user: str, path: str, data: bytes) -> None:
        if not path.startswith(f"{user}/"):
            raise PermissionError("uploads go in the user's own folder")
        with self._lock:
            self._data(user).files[path] = data

    def add_chunks(
        self, user: str, course_id: UUID, source_id: UUID, chunks: Sequence[NewChunk]
    ) -> list[UUID]:
        with self._lock:
            self._require(user, course_id)
            data = self._data(user)
            ids = []
            for chunk in chunks:
                cid = uuid.uuid4()
                data.chunks[cid] = _Chunk(
                    cid,
                    course_id,
                    source_id,
                    chunk.page,
                    chunk.heading,
                    chunk.text,
                    chunk.embedding,
                    chunk.notebook_node_id,
                )
                ids.append(cid)
            return ids

    def node_passages(self, user: str) -> dict[UUID, list[str]]:
        """Course passages by the notebook chapter they were imported into (K8 filing)."""
        with self._lock:
            passages: dict[UUID, list[str]] = {}
            for chunk in self._data(user).chunks.values():
                if chunk.notebook_node_id is not None:
                    text = f"{chunk.heading or ''} {chunk.text}"[:1200]
                    passages.setdefault(chunk.notebook_node_id, []).append(text)
            return passages

    def match_chunks(
        self, user: str, course_id: UUID, embedding: list[float], k: int
    ) -> list[RetrievedChunk]:
        with self._lock:
            data = self._data(user)
            titles = {s.id: s.title for s in data.sources.values()}
            scored = [
                (_cosine(c.embedding, embedding), c)
                for c in data.chunks.values()
                if c.course_id == course_id
            ]
        scored.sort(key=lambda pair: pair[0], reverse=True)
        return [
            RetrievedChunk(
                page=c.page,
                heading=c.heading,
                text=c.text,
                similarity=round(score, 4),
                source_title=titles.get(c.source_id, ""),
            )
            for score, c in scored[: min(k, 20)]
        ]

    def chunk_ids_on_pages(self, user: str, course_id: UUID, pages: list[int]) -> list[UUID]:
        wanted = set(pages)
        with self._lock:
            return [
                c.id
                for c in self._data(user).chunks.values()
                if c.course_id == course_id and c.page in wanted
            ]

    def add_concepts(
        self, user: str, course_id: UUID, concepts: Sequence[NewConcept]
    ) -> list[UUID]:
        with self._lock:
            self._require(user, course_id)
            data = self._data(user)
            ids = []
            for concept in concepts:
                cid = uuid.uuid4()
                data.concepts[cid] = Concept(
                    id=cid, course_id=course_id, **concept.model_dump(), lesson=None
                )
                ids.append(cid)
            return ids

    def list_concepts(self, user: str, course_id: UUID) -> list[Concept]:
        with self._lock:
            found = [c for c in self._data(user).concepts.values() if c.course_id == course_id]
        return sorted(found, key=lambda c: c.order_index)

    def update_concept(self, user: str, concept_id: UUID, fields: dict[str, Any]) -> None:
        with self._lock:
            data = self._data(user)
            concept = data.concepts.get(concept_id)
            if concept is None:
                raise CourseNotFoundError(concept_id)
            if isinstance(fields.get("lesson"), dict):
                fields = {**fields, "lesson": Lesson.model_validate(fields["lesson"])}
            data.concepts[concept_id] = concept.model_copy(update=fields)

    def delete_concepts(self, user: str, concept_ids: Sequence[UUID]) -> None:
        gone = set(concept_ids)
        with self._lock:
            data = self._data(user)
            for cid in gone:
                data.concepts.pop(cid, None)
            data.edges = {e for e in data.edges if e[0] not in gone and e[1] not in gone}
            data.concept_sources = {link for link in data.concept_sources if link[0] not in gone}
            self._forget_learning(data, gone)

    def add_edges(self, user: str, edges: Sequence[Edge]) -> None:
        with self._lock:
            data = self._data(user)
            for edge in edges:
                if edge.from_concept in data.concepts and edge.to_concept in data.concepts:
                    data.edges.add((edge.from_concept, edge.to_concept))

    def list_edges(self, user: str, course_id: UUID) -> list[Edge]:
        with self._lock:
            data = self._data(user)
            mine = {c.id for c in data.concepts.values() if c.course_id == course_id}
            return [
                Edge(from_concept=a, to_concept=b)
                for a, b in sorted(data.edges)
                if a in mine and b in mine
            ]

    def set_edges(self, user: str, course_id: UUID, edges: Sequence[Edge]) -> None:
        with self._lock:
            data = self._data(user)
            mine = {c.id for c in data.concepts.values() if c.course_id == course_id}
            data.edges = {e for e in data.edges if e[0] not in mine and e[1] not in mine}
        self.add_edges(user, edges)

    def add_concept_sources(self, user: str, links: Sequence[tuple[UUID, UUID]]) -> None:
        with self._lock:
            self._data(user).concept_sources.update(links)

    # ─── learner model ──────────────────────────────────────────────────────────────────────

    def has_concept(self, user: str, course_id: UUID, concept_id: UUID) -> bool:
        with self._lock:
            concept = self._data(user).concepts.get(concept_id)
            return concept is not None and concept.course_id == course_id

    def learner_data(self, user: str, course_id: UUID) -> LearnerData:
        with self._lock:
            data = self._data(user)
            attempts = [a for c, a in data.attempts if c == course_id][-MAX_ATTEMPTS:]
            cards = [card for c, card in data.cards.values() if c == course_id]
        return LearnerData(attempts=attempts, cards=cards)

    def add_attempt(self, user: str, course_id: UUID, attempt: AttemptWrite) -> None:
        with self._lock:
            if not self.has_concept(user, course_id, attempt.concept_id):
                raise CourseNotFoundError(attempt.concept_id)
            data = self._data(user)
            record = AttemptRecord(
                **attempt.model_dump(exclude={"card"}), created_at=datetime.now(UTC)
            )
            data.attempts.append((course_id, record))
            del data.attempts[:-MAX_LOCAL_ATTEMPTS]
            data.cards[attempt.concept_id] = (course_id, _card(attempt.concept_id, attempt.card))

    def start_card(self, user: str, course_id: UUID, concept_id: UUID, card: FsrsCard) -> None:
        with self._lock:
            if not self.has_concept(user, course_id, concept_id):
                raise CourseNotFoundError(concept_id)
            self._data(user).cards.setdefault(concept_id, (course_id, _card(concept_id, card)))

    def due_cards(self, user: str, before: datetime, limit: int) -> list[DueCard]:
        with self._lock:
            data = self._data(user)
            due = [
                DueCard(
                    course_id=course_id,
                    course_title=data.courses[course_id].title,
                    concept_id=card.concept_id,
                    concept_title=data.concepts[card.concept_id].title,
                    due_at=card.due_at,
                    reps=card.fsrs_state.reps,
                )
                for course_id, card in data.cards.values()
                if card.due_at <= before
            ]
        return sorted(due, key=lambda c: c.due_at)[:limit]

    @staticmethod
    def _forget_learning(data: _UserData, concepts: set[UUID]) -> None:
        data.attempts = [(c, a) for c, a in data.attempts if a.concept_id not in concepts]
        data.cards = {k: v for k, v in data.cards.items() if k not in concepts}

    def _require(self, user: str, course_id: UUID) -> None:
        if course_id not in self._data(user).courses:
            raise CourseNotFoundError(course_id)


def _card(concept_id: UUID, card: FsrsCard) -> CardRecord:
    return CardRecord(concept_id=concept_id, fsrs_state=card, due_at=card.due)


def _cosine(a: Sequence[float], b: Sequence[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b, strict=False))
    na = math.sqrt(sum(x * x for x in a)) or 1.0
    nb = math.sqrt(sum(y * y for y in b)) or 1.0
    return dot / (na * nb)
