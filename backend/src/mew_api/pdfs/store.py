"""Where notebook PDFs live: Supabase (a row in public.notebook_pdfs plus the file in the private
"pdfs" bucket, both with the student's Clerk token: RLS and folder policies apply) or, in local
mode, this process's memory, isolated per user like RLS."""

import threading
from collections import OrderedDict
from typing import Any, Protocol
from urllib.parse import quote
from uuid import UUID

from ..supabase_rest import SupabaseRest
from .models import PdfInfo, PdfOutlineItem

BUCKET = "pdfs"


def storage_path(user: str, pdf_id: UUID) -> str:
    return f"{user}/{pdf_id}.pdf"


class PdfStore(Protocol):
    def create(
        self,
        user: str,
        pdf_id: UUID,
        file_name: str,
        page_count: int,
        outline: list[PdfOutlineItem],
        data: bytes,
    ) -> PdfInfo: ...

    def get(self, user: str, pdf_id: UUID) -> PdfInfo | None: ...

    def data(self, user: str, pdf_id: UUID) -> bytes | None: ...

    def set_course(self, user: str, pdf_id: UUID, course_id: UUID) -> None: ...


def _info(row: dict[str, Any]) -> PdfInfo:
    return PdfInfo.model_validate(
        {
            "pdf_id": row["id"],
            "file_name": row["file_name"],
            "page_count": row["page_count"],
            "outline": row["outline"],
            "course_id": row.get("course_id"),
        }
    )


def _row(
    pdf_id: UUID, path: str, name: str, pages: int, outline: list[PdfOutlineItem], size: int
) -> dict[str, Any]:
    return {
        "id": str(pdf_id),
        "storage_path": path,
        "file_name": name,
        "byte_size": size,
        "page_count": pages,
        "outline": [o.model_dump(mode="json", by_alias=True) for o in outline],
    }


class MemoryPdfStore:
    """Local mode: a handful of PDFs per process (development only)."""

    MAX_FILES = 50

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._rows: OrderedDict[tuple[str, UUID], tuple[dict[str, Any], bytes]] = OrderedDict()

    def create(
        self,
        user: str,
        pdf_id: UUID,
        file_name: str,
        page_count: int,
        outline: list[PdfOutlineItem],
        data: bytes,
    ) -> PdfInfo:
        row = _row(pdf_id, storage_path(user, pdf_id), file_name, page_count, outline, len(data))
        with self._lock:
            self._rows[(user, pdf_id)] = (row, data)
            while len(self._rows) > self.MAX_FILES:
                self._rows.popitem(last=False)
        return _info(row)

    def get(self, user: str, pdf_id: UUID) -> PdfInfo | None:
        with self._lock:
            stored = self._rows.get((user, pdf_id))
        return _info(stored[0]) if stored else None

    def data(self, user: str, pdf_id: UUID) -> bytes | None:
        with self._lock:
            stored = self._rows.get((user, pdf_id))
        return stored[1] if stored else None

    def set_course(self, user: str, pdf_id: UUID, course_id: UUID) -> None:
        with self._lock:
            stored = self._rows.get((user, pdf_id))
            if stored:
                stored[0]["course_id"] = str(course_id)


class SupabasePdfStore(SupabaseRest):
    """The student's PDFs with their Clerk token. Upload first, then the row; a row that fails
    takes its upload with it, so no orphan file is left behind."""

    def create(
        self,
        user: str,
        pdf_id: UUID,
        file_name: str,
        page_count: int,
        outline: list[PdfOutlineItem],
        data: bytes,
    ) -> PdfInfo:
        if self.service:
            raise PermissionError("PDFs are stored with their owner's session")
        path = storage_path(user, pdf_id)
        self._request(
            "POST",
            f"/storage/v1/object/{BUCKET}/{quote(path)}",
            content=data,
            headers={"Content-Type": "application/pdf", "x-upsert": "false"},
        )
        try:
            rows = self._insert(
                "notebook_pdfs",
                [_row(pdf_id, path, file_name, page_count, outline, len(data))],
                select="id,file_name,page_count,outline,course_id",
            )
        except Exception:
            self._request(
                "DELETE", f"/storage/v1/object/{BUCKET}", json={"prefixes": [path]}, ok=(200, 404)
            )
            raise
        return _info(rows[0])

    def _one(self, user: str, pdf_id: UUID) -> dict[str, Any] | None:
        rows = self._get("notebook_pdfs", {"user_id": f"eq.{user}", "id": f"eq.{pdf_id}"})
        return rows[0] if rows else None

    def get(self, user: str, pdf_id: UUID) -> PdfInfo | None:
        row = self._one(user, pdf_id)
        return _info(row) if row else None

    def data(self, user: str, pdf_id: UUID) -> bytes | None:
        row = self._one(user, pdf_id)
        if row is None:
            return None
        response = self._request(
            "GET",
            f"/storage/v1/object/authenticated/{BUCKET}/{quote(row['storage_path'])}",
            ok=(400, 404),
        )
        return response.content if response.is_success else None

    def set_course(self, user: str, pdf_id: UUID, course_id: UUID) -> None:
        self._patch(
            "notebook_pdfs",
            {"user_id": f"eq.{user}", "id": f"eq.{pdf_id}"},
            {"course_id": str(course_id)},
        )
