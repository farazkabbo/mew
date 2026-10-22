"""CourseStore on Supabase (PostgREST and Storage; plumbing in ../supabase_rest.py).

The service mode (secret key) is used only by ingestion jobs, after the route has verified that
the caller owns the course.
"""

import json
from collections.abc import Iterable, Sequence
from datetime import UTC, datetime
from typing import Any
from urllib.parse import quote
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
from ..supabase_rest import StoreError, SupabaseRest
from .models import Concept, Course, Edge, NewChunk, NewConcept, RetrievedChunk, Source
from .store import CourseNotFoundError

BUCKET = "course-sources"
_INSERT_BATCH = 100


class SupabaseCourseStore(SupabaseRest):
    def ensure_profile(self, user: str) -> None:
        self._request(
            "POST",
            "/rest/v1/profiles",
            json={"id": user},
            headers={"Prefer": "resolution=ignore-duplicates,return=minimal"},
        )

    # ─── courses ────────────────────────────────────────────────────────────────────────────

    def create_course(self, user: str, title: str) -> Course:
        row = self._insert("courses", [self._owned(user, {"title": title})])[0]
        return Course.model_validate(_course_fields(row))

    def list_courses(self, user: str) -> list[Course]:
        rows = self._get("courses", {"user_id": f"eq.{user}", "order": "created_at.desc"})
        return [Course.model_validate(_course_fields(r)) for r in rows]

    def get_course(self, user: str, course_id: UUID) -> Course | None:
        rows = self._get("courses", {"user_id": f"eq.{user}", "id": f"eq.{course_id}"})
        return Course.model_validate(_course_fields(rows[0])) if rows else None

    def update_course(self, user: str, course_id: UUID, fields: dict[str, Any]) -> None:
        self._patch_one("courses", {"user_id": f"eq.{user}", "id": f"eq.{course_id}"}, fields)

    def delete_course(self, user: str, course_id: UUID) -> None:
        paths = [s.storage_path for s in self.list_sources(user, course_id) if s.storage_path]
        self._delete("courses", {"user_id": f"eq.{user}", "id": f"eq.{course_id}"})
        if paths:
            self._request(
                "DELETE", f"/storage/v1/object/{BUCKET}", json={"prefixes": paths}, ok=(200, 404)
            )

    # ─── sources and files ──────────────────────────────────────────────────────────────────

    def add_source(self, user: str, source: Source) -> None:
        self._insert(
            "sources", [self._owned(user, source.model_dump(mode="json"))], returning=False
        )

    def list_sources(self, user: str, course_id: UUID) -> list[Source]:
        rows = self._get(
            "sources",
            {
                "user_id": f"eq.{user}",
                "course_id": f"eq.{course_id}",
                "select": "id,course_id,kind,title,page_count,embedding_model,storage_path",
            },
        )
        return [Source.model_validate(r) for r in rows]

    def upload(self, user: str, path: str, data: bytes) -> None:
        if not path.startswith(f"{user}/"):
            raise PermissionError("uploads go in the user's own folder")
        self._request(
            "POST",
            f"/storage/v1/object/{BUCKET}/{quote(path)}",
            content=data,
            headers={"Content-Type": "application/pdf", "x-upsert": "false"},
        )

    # ─── chunks ─────────────────────────────────────────────────────────────────────────────

    def add_chunks(
        self, user: str, course_id: UUID, source_id: UUID, chunks: Sequence[NewChunk]
    ) -> list[UUID]:
        rows = [
            self._owned(
                user,
                {
                    "course_id": str(course_id),
                    "source_id": str(source_id),
                    "page": c.page,
                    "heading": c.heading,
                    "text": c.text,
                    "embedding": _vector(c.embedding),
                },
            )
            for c in chunks
        ]
        ids: list[UUID] = []
        for start in range(0, len(rows), _INSERT_BATCH):
            inserted = self._insert("chunks", rows[start : start + _INSERT_BATCH], select="id")
            ids.extend(UUID(r["id"]) for r in inserted)
        return ids

    def match_chunks(
        self, user: str, course_id: UUID, embedding: list[float], k: int
    ) -> list[RetrievedChunk]:
        rows = self._request(
            "POST",
            "/rest/v1/rpc/match_chunks",
            json={"course": str(course_id), "query": _vector(embedding), "match_count": k},
        ).json()
        title = next((s.title for s in self.list_sources(user, course_id)), "")
        return [
            RetrievedChunk(
                page=r["page"],
                heading=r.get("heading"),
                text=r["text"],
                similarity=round(float(r["similarity"]), 4),
                source_title=title,
            )
            for r in rows
        ]

    def chunk_ids_on_pages(self, user: str, course_id: UUID, pages: list[int]) -> list[UUID]:
        if not pages:
            return []
        rows = self._get(
            "chunks",
            {
                "select": "id",
                "user_id": f"eq.{user}",
                "course_id": f"eq.{course_id}",
                "page": f"in.({','.join(str(p) for p in pages)})",
            },
        )
        return [UUID(r["id"]) for r in rows]

    # ─── concepts ───────────────────────────────────────────────────────────────────────────

    def add_concepts(
        self, user: str, course_id: UUID, concepts: Sequence[NewConcept]
    ) -> list[UUID]:
        rows = [
            self._owned(user, {"course_id": str(course_id), **c.model_dump()}) for c in concepts
        ]
        return [UUID(r["id"]) for r in self._insert("concepts", rows, select="id")]

    def list_concepts(self, user: str, course_id: UUID) -> list[Concept]:
        rows = self._get(
            "concepts",
            {
                "user_id": f"eq.{user}",
                "course_id": f"eq.{course_id}",
                "order": "order_index.asc",
                "select": "id,course_id,title,summary,order_index,source_pages,lesson",
            },
        )
        return [Concept.model_validate(r) for r in rows]

    def update_concept(self, user: str, concept_id: UUID, fields: dict[str, Any]) -> None:
        self._patch_one("concepts", {"user_id": f"eq.{user}", "id": f"eq.{concept_id}"}, fields)

    def delete_concepts(self, user: str, concept_ids: Sequence[UUID]) -> None:
        if concept_ids:
            self._delete("concepts", {"user_id": f"eq.{user}", "id": f"in.({_ids(concept_ids)})"})

    def add_edges(self, user: str, edges: Sequence[Edge]) -> None:
        if edges:
            rows = [self._owned(user, e.model_dump(mode="json")) for e in edges]
            self._insert("concept_edges", rows, returning=False)

    def list_edges(self, user: str, course_id: UUID) -> list[Edge]:
        ids = [c.id for c in self.list_concepts(user, course_id)]
        if not ids:
            return []
        rows = self._get(
            "concept_edges",
            {
                "user_id": f"eq.{user}",
                "from_concept": f"in.({_ids(ids)})",
                "select": "from_concept,to_concept",
            },
        )
        return [Edge.model_validate(r) for r in rows]

    def set_edges(self, user: str, course_id: UUID, edges: Sequence[Edge]) -> None:
        ids = [c.id for c in self.list_concepts(user, course_id)]
        if ids:
            self._delete(
                "concept_edges", {"user_id": f"eq.{user}", "from_concept": f"in.({_ids(ids)})"}
            )
        self.add_edges(user, edges)

    def add_concept_sources(self, user: str, links: Sequence[tuple[UUID, UUID]]) -> None:
        rows = [self._owned(user, {"concept_id": str(c), "chunk_id": str(k)}) for c, k in links]
        for start in range(0, len(rows), _INSERT_BATCH):
            self._insert("concept_sources", rows[start : start + _INSERT_BATCH], returning=False)

    # ─── learner model ─────────────────────────────────────────────────────────────────────

    def has_concept(self, user: str, course_id: UUID, concept_id: UUID) -> bool:
        params = {"user_id": f"eq.{user}", "course_id": f"eq.{course_id}"}
        return bool(self._get("concepts", {**params, "id": f"eq.{concept_id}", "select": "id"}))

    def learner_data(self, user: str, course_id: UUID) -> LearnerData:
        scope = {"user_id": f"eq.{user}", "course_id": f"eq.{course_id}"}
        attempts = self._get(
            "attempts",
            {
                **scope,
                "select": "concept_id,correct,evidence,source,created_at",
                "order": "created_at.desc",
                "limit": str(MAX_ATTEMPTS),
            },
        )
        cards = self._get("review_cards", {**scope, "select": "concept_id,fsrs_state,due_at"})
        return LearnerData(
            attempts=[AttemptRecord.model_validate(r) for r in reversed(attempts)],
            cards=[CardRecord.model_validate(r) for r in cards],
        )

    def add_attempt(self, user: str, course_id: UUID, attempt: AttemptWrite) -> None:
        row = {"course_id": str(course_id), **attempt.model_dump(mode="json", exclude={"card"})}
        self._insert("attempts", [self._owned(user, row)], returning=False)
        # Update the card in place, or create it on the concept's first attempt.
        response = self._request(
            "PATCH",
            "/rest/v1/review_cards",
            params={"user_id": f"eq.{user}", "concept_id": f"eq.{attempt.concept_id}"},
            content=json.dumps(_card_fields(attempt.card)),
            headers={"Content-Type": "application/json", "Prefer": "return=representation"},
        )
        if response.json() == []:
            self.start_card(user, course_id, attempt.concept_id, attempt.card)

    def start_card(self, user: str, course_id: UUID, concept_id: UUID, card: FsrsCard) -> None:
        row = {"course_id": str(course_id), "concept_id": str(concept_id), **_card_fields(card)}
        self._request(
            "POST",
            "/rest/v1/review_cards",
            params={"on_conflict": "concept_id,user_id"},
            json=[self._owned(user, row)],
            headers={"Prefer": "resolution=ignore-duplicates,return=minimal"},
        )

    def due_cards(self, user: str, before: datetime, limit: int) -> list[DueCard]:
        rows = self._get(
            "review_cards",
            {
                "user_id": f"eq.{user}",
                "due_at": f"lte.{before.astimezone(UTC).strftime('%Y-%m-%dT%H:%M:%SZ')}",
                "order": "due_at.asc",
                "limit": str(limit),
                "select": "course_id,concept_id,due_at,fsrs_state",
            },
        )
        if not rows:
            return []
        titles: dict[str, str] = {}
        for table, key in (("courses", "course_id"), ("concepts", "concept_id")):
            wanted = sorted({r[key] for r in rows})
            found = self._get(
                table,
                {"user_id": f"eq.{user}", "id": f"in.({','.join(wanted)})", "select": "id,title"},
            )
            titles.update({r["id"]: r["title"] for r in found})
        return [
            DueCard(
                course_id=r["course_id"],
                course_title=titles.get(r["course_id"], ""),
                concept_id=r["concept_id"],
                concept_title=titles.get(r["concept_id"], ""),
                due_at=r["due_at"],
                reps=FsrsCard.model_validate(r["fsrs_state"]).reps,
            )
            for r in rows
        ]

    def _patch_one(self, table: str, params: dict[str, str], fields: dict[str, Any]) -> None:
        if not self._patch(table, params, fields):
            raise CourseNotFoundError(params.get("id", ""))


def _vector(values: Sequence[float]) -> str:
    return "[" + ",".join(f"{v:.6f}" for v in values) + "]"


def _ids(ids: Iterable[UUID]) -> str:
    return ",".join(str(i) for i in ids)


def _card_fields(card: FsrsCard) -> dict[str, Any]:
    return {"fsrs_state": card.model_dump(mode="json"), "due_at": card.due.isoformat()}


def _course_fields(row: dict[str, Any]) -> dict[str, Any]:
    keys = ("id", "title", "subject", "exam_date", "status", "status_detail", "created_at")
    return {k: row.get(k) for k in keys}


__all__ = ["StoreError", "SupabaseCourseStore"]
