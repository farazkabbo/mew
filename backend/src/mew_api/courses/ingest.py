"""Course ingestion (brief §8): PDF → page text (OCR for scanned pages) → chunks → embeddings →
concept graph with prerequisites and source pages. Runs as a background job after the upload;
progress and failures are reported on the course's status."""

import logging
from dataclasses import dataclass
from typing import Annotated, Any
from uuid import UUID

from pydantic import BaseModel, StringConstraints

from ..checker.sandbox import CheckerPool, CheckTimeoutError
from .chunking import TextChunk, chunk_pages
from .concepts import extract_concepts
from .embeddings import Embedder
from .llm import GeminiLlm, LlmError
from .models import Edge, NewChunk, NewConcept
from .pdf import MAX_BYTES, MAX_PAGES, ParsedPage, PdfError, parse_pdf
from .prompts import OCR
from .store import CourseStore

logger = logging.getLogger(__name__)

PARSE_TIMEOUT_S = 90
#: Chunks linked to each concept as its sources.
SOURCES_PER_CONCEPT = 8


@dataclass(frozen=True)
class IngestJob:
    user: str
    course_id: UUID
    source_id: UUID
    title: str
    pdf: bytes
    #: A notebook PDF (K4): the chapter each page went to (1-based pages; others are left out),
    #: and its larger limits.
    page_nodes: dict[int, UUID] | None = None
    max_bytes: int = MAX_BYTES
    max_pages: int = MAX_PAGES


@dataclass(frozen=True)
class IngestTools:
    store: CourseStore
    embedder: Embedder
    llm: GeminiLlm | None
    #: Model for OCR (fast) and for the concept graph (smart).
    ocr_model: str
    concept_model: str
    pool: CheckerPool


def run_ingestion(job: IngestJob, tools: IngestTools) -> None:
    store = tools.store
    status = _Status(store, job)
    try:
        status.set("processing", "Reading the PDF")
        try:
            pages: list[ParsedPage] = tools.pool.run(
                parse_pdf, job.pdf, job.max_bytes, job.max_pages, timeout=PARSE_TIMEOUT_S
            )
        except PdfError as error:
            status.set("failed", f"Couldn't read that PDF: {error}.")
            return
        except CheckTimeoutError:
            status.set("failed", "The PDF took too long to read. Try a smaller file.")
            return

        if job.page_nodes is not None:
            pages = [p for p in pages if p["number"] in job.page_nodes]
        texts = _page_texts(pages, tools, status)
        chunks = chunk_pages(texts)
        if not chunks:
            status.set("failed", "No readable text found in the PDF.")
            return

        status.set("processing", f"Indexing {len(chunks)} passages")
        vectors = tools.embedder.embed_documents([(c.heading, c.text) for c in chunks])
        chunk_ids = store.add_chunks(
            job.user,
            job.course_id,
            job.source_id,
            [
                NewChunk(
                    page=c.page,
                    heading=c.heading,
                    text=c.text,
                    embedding=v,
                    notebook_node_id=(job.page_nodes or {}).get(c.page),
                )
                for c, v in zip(chunks, vectors, strict=True)
            ],
        )

        status.set("processing", "Finding the key concepts")
        graph = extract_concepts(chunks, tools.llm, tools.concept_model, job.title)
        concept_ids = store.add_concepts(
            job.user,
            job.course_id,
            [
                NewConcept(title=c.title, summary=c.summary, order_index=i, source_pages=c.pages)
                for i, c in enumerate(graph.concepts)
            ],
        )
        store.add_edges(
            job.user,
            [
                Edge(from_concept=concept_ids[p], to_concept=concept_ids[i])
                for i, c in enumerate(graph.concepts)
                for p in c.prerequisites
            ],
        )
        store.add_concept_sources(job.user, _links(graph.concepts, concept_ids, chunks, chunk_ids))

        page_count = len(pages)
        store.update_course(
            job.user,
            job.course_id,
            {
                "subject": graph.subject,
                "status": "review",
                "status_detail": f"{len(concept_ids)} concepts from {page_count} pages",
            },
        )
    except Exception:
        logger.exception("Ingestion of course %s failed", job.course_id)
        status.set("failed", "Something went wrong while building the course. Please try again.")


def _page_texts(
    pages: list[ParsedPage], tools: IngestTools, status: "_Status"
) -> list[tuple[int, str]]:
    """Page texts, with scanned pages transcribed by the model when one is available."""
    texts: list[tuple[int, str]] = []
    scanned = [p for p in pages if p["image"] is not None]
    if scanned and tools.llm is not None:
        status.set("processing", f"Reading {len(scanned)} scanned page(s)")
    for page in pages:
        text = page["text"]
        image = page["image"]
        if image is not None and tools.llm is not None:
            try:
                text = tools.llm.structured(
                    model=tools.ocr_model,
                    system=OCR.system,
                    text=f"Page {page['number']}.",
                    schema=_OcrResult,
                    images=[image],
                    thinking="minimal",
                    max_tokens=4000,
                ).text
            except LlmError as error:
                logger.warning("OCR of page %s failed: %s", page["number"], error)
        texts.append((page["number"], text))
    return texts


def _links(
    concepts: list[Any],
    concept_ids: list[UUID],
    chunks: list[TextChunk],
    chunk_ids: list[UUID],
) -> list[tuple[UUID, UUID]]:
    """Each concept's sources: chunks on its pages (or under its heading), a few per concept."""
    links: list[tuple[UUID, UUID]] = []
    for concept, cid in zip(concepts, concept_ids, strict=True):
        pages = set(concept.pages)
        title = concept.title.casefold()
        matches = [
            kid
            for chunk, kid in zip(chunks, chunk_ids, strict=True)
            if chunk.page in pages or (chunk.heading and title in chunk.heading.casefold())
        ]
        links.extend((cid, kid) for kid in matches[:SOURCES_PER_CONCEPT])
    return links


class _OcrResult(BaseModel):
    text: Annotated[str, StringConstraints(max_length=12_000)] = ""


class _Status:
    def __init__(self, store: CourseStore, job: IngestJob) -> None:
        self.store = store
        self.job = job

    def set(self, status: str, detail: str) -> None:
        try:
            self.store.update_course(
                self.job.user, self.job.course_id, {"status": status, "status_detail": detail[:300]}
            )
        except Exception:
            logger.exception("Couldn't update the status of course %s", self.job.course_id)
