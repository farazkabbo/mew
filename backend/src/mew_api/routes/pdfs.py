"""Notebook PDFs (K4, docs/NOTEBOOKS_K.md §5): import a PDF, draw its pages under the student's
ink, read their text layer, and (optionally) use it as course material scoped to chapters.

Every route acts for the signed-in student (Clerk token; local user in development) on their own
files only. The file is untrusted: it's inspected, rendered and read only in the sandboxed ingest
worker (time limit per call, 1 GB cap), with a pdfium build that has no JavaScript, never
drawing forms. Logs carry ids, counts and timings, never file names or text.
"""

import logging
import threading
from collections import OrderedDict
from collections.abc import Callable
from typing import Annotated
from uuid import UUID, uuid4

from fastapi import (
    APIRouter,
    BackgroundTasks,
    HTTPException,
    Path,
    Query,
    Request,
    Response,
    status,
)
from starlette.concurrency import run_in_threadpool

from ..checker.sandbox import CheckTimeoutError
from ..config import Settings
from ..courses.ingest import IngestJob, IngestTools, run_ingestion
from ..courses.models import Source
from ..deps import Caller, CurrentCaller, SettingsDep
from ..pdfs.models import PdfCourseRequest, PdfCourseStarted, PdfInfo, PdfOutlineItem, PdfPageText
from ..pdfs.reader import PdfReadError, inspect_pdf, page_words, render_page
from ..pdfs.store import MemoryPdfStore, PdfStore, SupabasePdfStore
from ..supabase_rest import StoreError
from .courses import _call as course_call
from .courses import _embedder, _job_store, _llm, _user_store

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/pdfs", tags=["pdfs"])

INSPECT_TIMEOUT_S = 30
RENDER_TIMEOUT_S = 30
#: What a student is told for each reason a file can't be imported (§5.2).
REFUSALS = {
    "not_pdf": "That file isn't a PDF.",
    "encrypted": "Neb can't import password-protected PDFs. Remove the password and try again.",
    "too_many_pages": "That PDF has too many pages to import.",
    "empty": "That PDF has no pages.",
    "unreadable": "That PDF couldn't be read. It may be damaged.",
    "no_page": "That page isn't in the PDF.",
}


def _store(request: Request, caller: Caller, settings: Settings) -> PdfStore:
    if caller.is_local:
        local: MemoryPdfStore = request.app.state.local_pdfs
        return local
    if not settings.supabase_url or not settings.supabase_publishable_key:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "PDFs aren't configured")
    return SupabasePdfStore(
        settings.supabase_url, api_key=settings.supabase_publishable_key, user_token=caller.token
    )


def _call[T](fn: Callable[[], T]) -> T:
    try:
        return fn()
    except PermissionError:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Unauthorized") from None
    except StoreError:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, "PDF storage unavailable") from None


def _refused(error: PdfReadError) -> HTTPException:
    code = (
        status.HTTP_404_NOT_FOUND
        if error.reason == "no_page"
        else status.HTTP_422_UNPROCESSABLE_CONTENT
    )
    return HTTPException(code, REFUSALS.get(error.reason, REFUSALS["unreadable"]))


def _file_name(raw: str) -> str:
    """The file's name as shown (no folders, no control characters)."""
    name = raw.replace("\\", "/").split("/")[-1]
    name = "".join(c for c in name if c.isprintable()).strip()
    return name[:200] or "document.pdf"


class _Cache:
    """Recently used PDFs and rendered pages, per user (never shared across users)."""

    def __init__(self, files: int = 4, pages: int = 64) -> None:
        self._lock = threading.Lock()
        self._files: OrderedDict[tuple[str, UUID], bytes] = OrderedDict()
        self._pages: OrderedDict[tuple[str, UUID, int], bytes] = OrderedDict()
        self._limits = (files, pages)

    def file(self, user: str, pdf_id: UUID, load: Callable[[], bytes | None]) -> bytes | None:
        key = (user, pdf_id)
        with self._lock:
            if key in self._files:
                self._files.move_to_end(key)
                return self._files[key]
        data = load()
        if data is not None:
            with self._lock:
                self._files[key] = data
                while len(self._files) > self._limits[0]:
                    self._files.popitem(last=False)
        return data

    def page(self, key: tuple[str, UUID, int], render: Callable[[], bytes]) -> bytes:
        with self._lock:
            if key in self._pages:
                self._pages.move_to_end(key)
                return self._pages[key]
        png = render()
        with self._lock:
            self._pages[key] = png
            while len(self._pages) > self._limits[1]:
                self._pages.popitem(last=False)
        return png


_cache = _Cache()


async def _read_limited(request: Request, limit: int) -> bytes:
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > limit:
        raise HTTPException(status.HTTP_413_CONTENT_TOO_LARGE, "That PDF is too large to import")
    body = bytearray()
    async for part in request.stream():
        body += part
        if len(body) > limit:
            raise HTTPException(
                status.HTTP_413_CONTENT_TOO_LARGE, "That PDF is too large to import"
            )
    return bytes(body)


@router.post("", status_code=status.HTTP_201_CREATED, response_model_exclude_none=True)
async def import_pdf(
    request: Request,
    caller: CurrentCaller,
    settings: SettingsDep,
    file_name: Annotated[str, Query(alias="fileName", min_length=1, max_length=300)],
) -> PdfInfo:
    """Keeps a PDF for the student's notebook: its page count and outline come back (the import
    dialog proposes chapters from the outline). Pages are drawn later, as they're viewed."""
    if request.headers.get("content-type", "").split(";")[0].strip() != "application/pdf":
        raise HTTPException(status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, "Send a PDF")
    data = await _read_limited(request, settings.pdf_max_bytes)
    try:
        inspected = await run_in_threadpool(
            request.app.state.ingest_pool.run,
            inspect_pdf,
            data,
            settings.pdf_max_pages,
            timeout=INSPECT_TIMEOUT_S,
        )
    except PdfReadError as error:
        raise _refused(error) from None
    except CheckTimeoutError:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT, "That PDF took too long to read."
        ) from None
    store = _store(request, caller, settings)
    pdf_id = uuid4()
    outline = [
        PdfOutlineItem(title=o["title"], page_index=o["page_index"]) for o in inspected["outline"]
    ]
    info = await run_in_threadpool(
        _call,
        lambda: store.create(
            caller.user_id, pdf_id, _file_name(file_name), inspected["page_count"], outline, data
        ),
    )
    logger.info(
        "Imported a PDF (%s, %d pages, %d KB)", pdf_id, inspected["page_count"], len(data) // 1024
    )
    return info.model_copy(update={"page_sizes": inspected["page_sizes"]})


@router.get("/{pdf_id}", response_model_exclude_none=True)
def get_pdf(
    pdf_id: UUID, request: Request, caller: CurrentCaller, settings: SettingsDep
) -> PdfInfo:
    info = _call(lambda: _store(request, caller, settings).get(caller.user_id, pdf_id))
    if info is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    return info


def _data(request: Request, caller: Caller, settings: Settings, pdf_id: UUID) -> bytes:
    store = _store(request, caller, settings)
    data = _call(
        lambda: _cache.file(caller.user_id, pdf_id, lambda: store.data(caller.user_id, pdf_id))
    )
    if data is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    return data


@router.get("/{pdf_id}/pages/{index}/image")
def page_image(
    pdf_id: UUID,
    index: Annotated[int, Path(ge=0, le=999)],
    request: Request,
    caller: CurrentCaller,
    settings: SettingsDep,
) -> Response:
    """Page `index` (0-based) drawn as a PNG, to go under the student's ink."""
    data = _data(request, caller, settings, pdf_id)
    pool = request.app.state.ingest_pool
    try:
        png = _cache.page(
            (caller.user_id, pdf_id, index),
            lambda: pool.run(render_page, data, index, timeout=RENDER_TIMEOUT_S),
        )
    except PdfReadError as error:
        raise _refused(error) from None
    except CheckTimeoutError:
        raise HTTPException(status.HTTP_504_GATEWAY_TIMEOUT, "That page took too long") from None
    return Response(
        content=png,
        media_type="image/png",
        headers={"Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff"},
    )


@router.get("/{pdf_id}/pages/{index}/text")
def page_text(
    pdf_id: UUID,
    index: Annotated[int, Path(ge=0, le=999)],
    request: Request,
    caller: CurrentCaller,
    settings: SettingsDep,
) -> PdfPageText:
    """Page `index`'s text layer, word by word with boxes (searching, Circle & Ask, the tutor)."""
    data = _data(request, caller, settings, pdf_id)
    try:
        text = request.app.state.ingest_pool.run(page_words, data, index, timeout=RENDER_TIMEOUT_S)
    except PdfReadError as error:
        raise _refused(error) from None
    except CheckTimeoutError:
        raise HTTPException(status.HTTP_504_GATEWAY_TIMEOUT, "That page took too long") from None
    return PdfPageText.model_validate(text)


@router.post("/{pdf_id}/course", status_code=status.HTTP_202_ACCEPTED)
async def use_as_course(
    pdf_id: UUID,
    body: PdfCourseRequest,
    request: Request,
    background: BackgroundTasks,
    caller: CurrentCaller,
    settings: SettingsDep,
) -> PdfCourseStarted:
    """ "Use as course material" (§5.1, decision 8): the PDF's pages become passages of a course
    (a new one when the notebook has none), each knowing the chapter its page went to. Concepts
    are found in the background; the import never waits for them."""
    data = await run_in_threadpool(_data, request, caller, settings, pdf_id)
    pdfs = _store(request, caller, settings)
    store = _user_store(request, caller, settings)
    jobs = _job_store(request, caller, settings)
    embedder = _embedder(request, settings)
    user = caller.user_id
    page_nodes = {
        page: section.node_id
        for section in body.sections
        for page in range(section.first_page, section.last_page + 1)
    }

    def start() -> PdfCourseStarted:
        store.ensure_profile(user)
        if body.course_id is not None:
            course = store.get_course(user, body.course_id)
            if course is None:
                raise HTTPException(status.HTTP_404_NOT_FOUND, "Course not found")
        else:
            course = store.create_course(user, body.title)
        source_id = uuid4()
        store.add_source(
            user,
            Source(
                id=source_id,
                course_id=course.id,
                kind="pdf",
                title=body.title,
                embedding_model=embedder.model,
                storage_path=f"{user}/{pdf_id}.pdf",
            ),
        )
        pdfs.set_course(user, pdf_id, course.id)
        background.add_task(
            run_ingestion,
            IngestJob(
                user=user,
                course_id=course.id,
                source_id=source_id,
                title=body.title,
                pdf=data,
                page_nodes=page_nodes,
                max_bytes=settings.pdf_max_bytes,
                max_pages=settings.pdf_max_pages,
            ),
            IngestTools(
                store=jobs,
                embedder=embedder,
                llm=_llm(request, settings),
                ocr_model=settings.gemini_gate_model,
                concept_model=settings.course_model,
                pool=request.app.state.ingest_pool,
            ),
        )
        logger.info("A PDF became course material (%s, %d pages)", course.id, len(page_nodes))
        return PdfCourseStarted(course_id=course.id)

    return await run_in_threadpool(course_call, start)
