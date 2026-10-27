"""Courses (M7): upload a PDF, review the concepts, study with lessons and retrieval."""

import logging
from collections.abc import Callable
from typing import Annotated, Any
from uuid import UUID, uuid4

from fastapi import APIRouter, BackgroundTasks, Header, HTTPException, Query, Request, status
from google import genai
from starlette.concurrency import run_in_threadpool

from ..config import Settings
from ..courses.embeddings import LEXICAL_MODEL, Embedder, GeminiEmbedder, LexicalEmbedder
from ..courses.ingest import IngestJob, IngestTools, run_ingestion
from ..courses.lessons import generate_lesson
from ..courses.llm import GeminiLlm
from ..courses.models import (
    ConceptReview,
    Course,
    CourseDetail,
    CourseUpdate,
    Edge,
    Lesson,
    RetrievedChunk,
    RetrieveRequest,
    RetrieveResponse,
    Source,
)
from ..courses.pdf import MAX_BYTES
from ..courses.store import CourseNotFoundError, CourseStore
from ..courses.supabase_store import StoreError, SupabaseCourseStore
from ..deps import Caller, CurrentCaller, SettingsDep
from .devices import screen_device

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/courses", tags=["courses"])

CourseTitle = Annotated[str, Query(min_length=1, max_length=120)]

#: Screen answers (S5): the courses searched (the newest first) and how close a passage must be
#: (word overlap, used in local mode, scores far lower than embeddings).
DEVICE_COURSES = 8
DEVICE_MIN_SIMILARITY = 0.3
DEVICE_MIN_SIMILARITY_LEXICAL = 0.1


# ─── Dependencies ────────────────────────────────────────────────────────────────────────────


def _user_store(request: Request, caller: Caller, settings: Settings) -> CourseStore:
    """The caller's courses: RLS-scoped Supabase for signed-in users, memory in local mode."""
    if caller.is_local:
        store: CourseStore = request.app.state.local_courses
        return store
    if not settings.supabase_url or not settings.supabase_publishable_key:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Courses aren't configured")
    return SupabaseCourseStore(
        settings.supabase_url, api_key=settings.supabase_publishable_key, user_token=caller.token
    )


def _job_store(request: Request, caller: Caller, settings: Settings) -> CourseStore:
    """The store an ingestion job writes with. Session tokens expire within minutes, so jobs
    use the secret key, for a course this request has just created for the verified caller."""
    if caller.is_local:
        store: CourseStore = request.app.state.local_courses
        return store
    if not settings.supabase_url or settings.supabase_secret_key is None:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE, "Course building isn't configured on the server"
        )
    return SupabaseCourseStore(
        settings.supabase_url,
        api_key=settings.supabase_secret_key.get_secret_value(),
        user_token=None,
    )


def _gemini(request: Request, settings: Settings) -> genai.Client | None:
    if settings.gemini_api_key is None:
        return None
    client: genai.Client | None = getattr(request.app.state, "gemini", None)
    if client is None:
        client = genai.Client(api_key=settings.gemini_api_key.get_secret_value())
        request.app.state.gemini = client
    return client


def _embedder(request: Request, settings: Settings, model: str | None = None) -> Embedder:
    """The embedder that made (or will make) a source's chunks."""
    client = _gemini(request, settings)
    wanted = model or (settings.gemini_embed_model if client else LEXICAL_MODEL)
    if wanted == LEXICAL_MODEL:
        return LexicalEmbedder()
    if client is None:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Search isn't configured")
    return GeminiEmbedder(client, wanted)


def _llm(request: Request, settings: Settings) -> GeminiLlm | None:
    client = _gemini(request, settings)
    return GeminiLlm(client) if client else None


def _call[T](fn: Callable[[], T]) -> T:
    """Maps store failures to safe HTTP errors (details stay in the logs)."""
    try:
        return fn()
    except CourseNotFoundError:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Course not found") from None
    except PermissionError:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Unauthorized") from None
    except StoreError:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, "Course storage unavailable") from None


def _forget(store: CourseStore, user: str, course_id: UUID) -> None:
    """Deletes a course whose creation failed halfway (best effort: the error that stopped it is
    the one reported)."""
    try:
        store.delete_course(user, course_id)
    except Exception:
        logger.exception("Couldn't remove half-created course %s", course_id)


# ─── Routes ──────────────────────────────────────────────────────────────────────────────────


@router.post("", status_code=status.HTTP_202_ACCEPTED)
async def create_course(
    request: Request,
    background: BackgroundTasks,
    caller: CurrentCaller,
    settings: SettingsDep,
    title: CourseTitle,
) -> Course:
    """Starts building a course from a PDF (the request body). Returns at once; the course's
    status moves from "processing" to "review" (or "failed") as the job runs."""
    if request.headers.get("content-type", "").split(";")[0].strip() != "application/pdf":
        raise HTTPException(status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, "Send a PDF")
    pdf = await _read_limited(request, MAX_BYTES)
    if not pdf.startswith(b"%PDF-"):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "That file isn't a PDF")

    store = _user_store(request, caller, settings)
    jobs = _job_store(request, caller, settings)  # fail before creating anything
    embedder = _embedder(request, settings)
    user = caller.user_id

    def create() -> Course:
        store.ensure_profile(user)
        course = store.create_course(user, title.strip())
        source_id = uuid4()
        path = f"{user}/{source_id}.pdf"
        try:
            store.upload(user, path, pdf)
            store.add_source(
                user,
                Source(
                    id=source_id,
                    course_id=course.id,
                    kind="pdf",
                    title=title.strip(),
                    embedding_model=embedder.model,
                    storage_path=path,
                ),
            )
        except Exception:
            # No job will ever run for it: a course left here would say "processing" forever.
            _forget(store, user, course.id)
            raise
        background.add_task(
            run_ingestion,
            IngestJob(user=user, course_id=course.id, source_id=source_id, title=title, pdf=pdf),
            IngestTools(
                store=jobs,
                embedder=embedder,
                llm=_llm(request, settings),
                ocr_model=settings.gemini_gate_model,
                concept_model=settings.course_model,
                pool=request.app.state.ingest_pool,
            ),
        )
        return course

    return await run_in_threadpool(_call, create)


@router.get("")
def list_courses(request: Request, caller: CurrentCaller, settings: SettingsDep) -> list[Course]:
    store = _user_store(request, caller, settings)
    return _call(lambda: store.list_courses(caller.user_id))


@router.get("/{course_id}")
def get_course(
    course_id: UUID, request: Request, caller: CurrentCaller, settings: SettingsDep
) -> CourseDetail:
    store = _user_store(request, caller, settings)
    return _call(lambda: _detail(store, caller.user_id, course_id))


@router.patch("/{course_id}")
def update_course(
    course_id: UUID,
    body: CourseUpdate,
    request: Request,
    caller: CurrentCaller,
    settings: SettingsDep,
) -> CourseDetail:
    store = _user_store(request, caller, settings)
    fields = body.model_dump(exclude_unset=True, mode="json")

    def update() -> CourseDetail:
        course = _require(store, caller.user_id, course_id)
        if fields.get("status") == "ready" and course.status != "review":
            raise HTTPException(status.HTTP_409_CONFLICT, "The course isn't ready for review yet")
        if fields:
            store.update_course(caller.user_id, course_id, fields)
        return _detail(store, caller.user_id, course_id)

    return _call(update)


@router.delete("/{course_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_course(
    course_id: UUID, request: Request, caller: CurrentCaller, settings: SettingsDep
) -> None:
    store = _user_store(request, caller, settings)
    _call(lambda: store.delete_course(caller.user_id, course_id))


@router.post("/{course_id}/review")
def review_concepts(
    course_id: UUID,
    body: ConceptReview,
    request: Request,
    caller: CurrentCaller,
    settings: SettingsDep,
) -> CourseDetail:
    """Applies the scope review: merges, removals (concepts left out of `order`), the new order,
    and renames. Prerequisites follow merged concepts and are kept acyclic (earlier → later)."""
    store = _user_store(request, caller, settings)
    user = caller.user_id

    def review() -> CourseDetail:
        _require(store, user, course_id)
        concepts = {c.id: c for c in store.list_concepts(user, course_id)}
        mentioned = set(body.order) | set(body.titles)
        for merge in body.merges:
            mentioned |= {merge.into, *merge.sources}
        if not mentioned <= concepts.keys():
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Unknown concept")

        target = {cid: cid for cid in concepts}
        for merge in body.merges:
            if merge.into in merge.sources:
                raise HTTPException(
                    status.HTTP_400_BAD_REQUEST, "Can't merge a concept into itself"
                )
            pages = set(concepts[merge.into].source_pages)
            for source in merge.sources:
                target[source] = merge.into
                pages |= set(concepts[source].source_pages)
            store.update_concept(user, merge.into, {"source_pages": sorted(pages)[:50]})

        merged_away = {cid for cid, t in target.items() if t != cid}
        keep = [cid for cid in body.order if cid not in merged_away]
        if len(set(keep)) != len(keep) or not keep:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST, "The order must list each kept concept once"
            )
        position = {cid: i for i, cid in enumerate(keep)}
        old_edges = store.list_edges(user, course_id)
        edges = {
            (target[e.from_concept], target[e.to_concept])
            for e in old_edges
            if target[e.from_concept] in position and target[e.to_concept] in position
        }
        # Prerequisites must come first: drop any that now point backwards.
        edges = {(a, b) for a, b in edges if a != b and position[a] < position[b]}

        store.delete_concepts(user, [cid for cid in concepts if cid not in position])
        for cid, index in position.items():
            fields: dict[str, Any] = {"order_index": index}
            if cid in body.titles:
                fields["title"] = body.titles[cid]
            store.update_concept(user, cid, fields)
        store.set_edges(user, course_id, [Edge(from_concept=a, to_concept=b) for a, b in edges])
        return _detail(store, user, course_id)

    return _call(review)


@router.post("/device/retrieve")
def retrieve_for_device(
    body: RetrieveRequest,
    request: Request,
    settings: SettingsDep,
    x_mew_device_token: Annotated[str | None, Header()] = None,
) -> RetrieveResponse:
    """For an answer about the screen (Screen Coach S5): the passages of the student's own
    courses closest to what they asked, across their ready courses. The device names no course,
    so the search only ever reads its owner's."""
    device = screen_device(x_mew_device_token, request, settings)
    if device.local:
        store: CourseStore = request.app.state.local_courses
    elif settings.supabase_url and settings.supabase_secret_key is not None:
        # The secret key, so every query below is for `user` only (decision 40).
        store = SupabaseCourseStore(
            settings.supabase_url,
            api_key=settings.supabase_secret_key.get_secret_value(),
            user_token=None,
        )
    else:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Courses aren't configured")
    user = device.user_id

    def search() -> list[RetrievedChunk]:
        ready = [c for c in store.list_courses(user) if c.status == "ready"]
        ready.sort(key=lambda c: c.created_at, reverse=True)
        close: list[RetrievedChunk] = []
        for course in ready[:DEVICE_COURSES]:
            sources = store.list_sources(user, course.id)
            lexical = bool(sources) and sources[0].embedding_model == LEXICAL_MODEL
            floor = DEVICE_MIN_SIMILARITY_LEXICAL if lexical else DEVICE_MIN_SIMILARITY
            try:
                found = _retrieve(request, settings, store, user, course.id, body.query, body.k)
            except CourseNotFoundError:
                continue
            close += [c for c in found if c.similarity >= floor]
        return sorted(close, key=lambda c: c.similarity, reverse=True)[: body.k]

    chunks = _call(search)
    logger.info("Found %d course passages for a screen answer", len(chunks))
    return RetrieveResponse(chunks=chunks)


@router.post("/{course_id}/retrieve")
def retrieve(
    course_id: UUID,
    body: RetrieveRequest,
    request: Request,
    caller: CurrentCaller,
    settings: SettingsDep,
) -> RetrieveResponse:
    """The passages of the course most relevant to a question (for the tutor's context)."""
    store = _user_store(request, caller, settings)
    return RetrieveResponse(
        chunks=_call(
            lambda: _retrieve(
                request, settings, store, caller.user_id, course_id, body.query, body.k
            )
        )
    )


@router.get("/{course_id}/concepts/{concept_id}/lesson")
def lesson(
    course_id: UUID,
    concept_id: UUID,
    request: Request,
    caller: CurrentCaller,
    settings: SettingsDep,
) -> Lesson:
    """The concept's lesson, generated on first view from the course material, then cached."""
    store = _user_store(request, caller, settings)
    user = caller.user_id

    def get() -> Lesson:
        concept = next(
            (c for c in store.list_concepts(user, course_id) if c.id == concept_id), None
        )
        if concept is None:
            raise CourseNotFoundError(concept_id)
        if concept.lesson is not None:
            return concept.lesson
        excerpts = _retrieve(
            request, settings, store, user, course_id, f"{concept.title}. {concept.summary}", 4
        )
        result = generate_lesson(concept, excerpts, _llm(request, settings), settings.course_model)
        if result.generated:  # cache real lessons; fallbacks are recomputed once a key exists
            store.update_concept(user, concept_id, {"lesson": result.model_dump(mode="json")})
        return result

    return _call(get)


# ─── Helpers ─────────────────────────────────────────────────────────────────────────────────


def _require(store: CourseStore, user: str, course_id: UUID) -> Course:
    course = store.get_course(user, course_id)
    if course is None:
        raise CourseNotFoundError(course_id)
    return course


def _detail(store: CourseStore, user: str, course_id: UUID) -> CourseDetail:
    course = _require(store, user, course_id)
    return CourseDetail(
        course=course,
        sources=store.list_sources(user, course_id),
        concepts=store.list_concepts(user, course_id),
        edges=store.list_edges(user, course_id),
    )


def _retrieve(
    request: Request,
    settings: Settings,
    store: CourseStore,
    user: str,
    course_id: UUID,
    query: str,
    k: int,
) -> list[RetrievedChunk]:
    _require(store, user, course_id)
    sources = store.list_sources(user, course_id)
    if not sources:
        return []
    embedder = _embedder(request, settings, sources[0].embedding_model)
    return store.match_chunks(user, course_id, embedder.embed_query(query), k)


async def _read_limited(request: Request, limit: int) -> bytes:
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > limit:
        raise HTTPException(status.HTTP_413_CONTENT_TOO_LARGE, "PDF too large (15 MB max)")
    body = bytearray()
    async for part in request.stream():
        body.extend(part)
        if len(body) > limit:
            raise HTTPException(status.HTTP_413_CONTENT_TOO_LARGE, "PDF too large (15 MB max)")
    return bytes(body)
