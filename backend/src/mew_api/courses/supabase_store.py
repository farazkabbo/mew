"""CourseStore on Supabase: PostgREST and Storage over HTTP.

Two modes:
- user: the publishable key plus the user's Clerk session token, so RLS scopes every row;
- service: the secret key (bypasses RLS), used only by ingestion jobs after the route has
  verified the caller owns the course. Every query still filters on user_id, and every insert
  sets it, so a bug can't cross users even here.
"""

import json
import logging
from collections.abc import Iterable, Sequence
from typing import Any
from urllib.parse import quote
from uuid import UUID

import httpx

from .models import Concept, Course, Edge, NewChunk, NewConcept, RetrievedChunk, Source
from .store import CourseNotFoundError

logger = logging.getLogger(__name__)

BUCKET = "course-sources"
_INSERT_BATCH = 100


class StoreError(RuntimeError):
    """Supabase refused or failed a request (details are logged, not exposed)."""


class SupabaseCourseStore:
    def __init__(
        self,
        url: str,
        *,
        api_key: str,
        user_token: str | None,
        client: httpx.Client | None = None,
    ) -> None:
        self.base = url.rstrip("/")
        headers = {"apikey": api_key}
        if user_token:
            headers["Authorization"] = f"Bearer {user_token}"
        self.service = user_token is None
        self.http = client or httpx.Client(timeout=20.0, follow_redirects=False)
        self.headers = headers

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
        self._patch("courses", {"user_id": f"eq.{user}", "id": f"eq.{course_id}"}, fields)

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
        self._patch("concepts", {"user_id": f"eq.{user}", "id": f"eq.{concept_id}"}, fields)

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

    # ─── HTTP ───────────────────────────────────────────────────────────────────────────────

    def _owned(self, user: str, row: dict[str, Any]) -> dict[str, Any]:
        # In user mode the database fills user_id from the token (and RLS checks it); in service
        # mode it must be set explicitly.
        return {**row, "user_id": user} if self.service else row

    def _get(self, table: str, params: dict[str, str]) -> list[dict[str, Any]]:
        rows = self._request("GET", f"/rest/v1/{table}", params={"select": "*", **params}).json()
        if not isinstance(rows, list):
            raise StoreError("unexpected response from Supabase")
        return rows

    def _insert(
        self,
        table: str,
        rows: list[dict[str, Any]],
        *,
        returning: bool = True,
        select: str = "*",
    ) -> list[dict[str, Any]]:
        if not rows:
            return []
        response = self._request(
            "POST",
            f"/rest/v1/{table}",
            params={"select": select} if returning else None,
            json=rows,
            headers={"Prefer": "return=representation" if returning else "return=minimal"},
        )
        return response.json() if returning else []

    def _patch(self, table: str, params: dict[str, str], fields: dict[str, Any]) -> None:
        response = self._request(
            "PATCH",
            f"/rest/v1/{table}",
            params=params,
            content=json.dumps(fields, default=str),
            headers={"Content-Type": "application/json", "Prefer": "return=representation"},
        )
        if response.json() == []:
            raise CourseNotFoundError(params.get("id", ""))

    def _delete(self, table: str, params: dict[str, str]) -> None:
        self._request("DELETE", f"/rest/v1/{table}", params=params)

    def _request(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, str] | None = None,
        json: Any = None,
        content: bytes | str | None = None,
        headers: dict[str, str] | None = None,
        ok: Iterable[int] = (),
    ) -> httpx.Response:
        try:
            response = self.http.request(
                method,
                f"{self.base}{path}",
                params=params,
                json=json,
                content=content,
                headers={**self.headers, **(headers or {})},
            )
        except httpx.HTTPError as error:
            raise StoreError(f"Supabase unreachable ({type(error).__name__})") from None
        if response.status_code in (401, 403):
            logger.info("Supabase refused %s %s: %s", method, path, response.status_code)
            raise PermissionError("not allowed")
        if response.is_error and response.status_code not in set(ok):
            logger.warning(
                "Supabase %s %s failed: %s %s",
                method,
                path,
                response.status_code,
                response.text[:300],
            )
            raise StoreError(f"Supabase request failed ({response.status_code})")
        return response


def _vector(values: Sequence[float]) -> str:
    return "[" + ",".join(f"{v:.6f}" for v in values) + "]"


def _ids(ids: Iterable[UUID]) -> str:
    return ",".join(str(i) for i in ids)


def _course_fields(row: dict[str, Any]) -> dict[str, Any]:
    keys = ("id", "title", "subject", "exam_date", "status", "status_detail", "created_at")
    return {k: row.get(k) for k in keys}
