"""Text embeddings for retrieval (768 dimensions, unit length, as the chunks table expects).

Gemini embeddings when a key is configured; otherwise a deterministic lexical embedding (hashed
words and word pairs), so local development and tests can still retrieve by word overlap. Each
source records which embedder made its chunks, and queries use the same one.
"""

import hashlib
import itertools
import logging
import math
import re
import time
from collections.abc import Callable, Sequence
from typing import Any, Protocol

from google import genai
from google.genai import types

DIMENSIONS = 768
LEXICAL_MODEL = "lexical-hash-v1"
BATCH = 32
#: When rate limited (429), how often to retry and the longest wait between tries. The free tier
#: allows 100 embedded texts a minute and asks for a wait of up to a minute, so a 160-passage PDF
#: takes a couple of these waits; the course shows "Indexing" meanwhile.
RATE_LIMIT_RETRIES = 6
MAX_RATE_LIMIT_WAIT_S = 65.0

logger = logging.getLogger(__name__)

#: Common words that carry no topic (shared with note search).
STOPWORDS = frozenset(
    [
        "a",
        "an",
        "and",
        "are",
        "as",
        "at",
        "be",
        "by",
        "for",
        "from",
        "has",
        "have",
        "in",
        "is",
        "it",
        "its",
        "of",
        "on",
        "or",
        "that",
        "the",
        "this",
        "to",
        "was",
        "were",
        "will",
        "with",
        "which",
        "what",
        "when",
        "where",
        "who",
        "why",
        "how",
        "into",
        "than",
        "then",
        "there",
        "these",
        "those",
        "can",
    ]
)


class Embedder(Protocol):
    model: str

    def embed_documents(self, texts: Sequence[tuple[str | None, str]]) -> list[list[float]]:
        """Embeds (heading, text) pairs."""
        ...

    def embed_query(self, text: str) -> list[float]: ...


def normalise(vector: Sequence[float]) -> list[float]:
    norm = math.sqrt(sum(v * v for v in vector)) or 1.0
    return [v / norm for v in vector]


class LexicalEmbedder:
    """Signed feature hashing of stemmed words and adjacent pairs."""

    model = LEXICAL_MODEL

    def embed_documents(self, texts: Sequence[tuple[str | None, str]]) -> list[list[float]]:
        return [self._embed(f"{heading or ''} {text}") for heading, text in texts]

    def embed_query(self, text: str) -> list[float]:
        return self._embed(text)

    def _embed(self, text: str) -> list[float]:
        words = [_stem(w) for w in re.findall(r"[a-z0-9]+", text.lower())]
        words = [w for w in words if len(w) > 1 and w not in STOPWORDS]
        features = words + [f"{a}_{b}" for a, b in itertools.pairwise(words)]
        vector = [0.0] * DIMENSIONS
        for feature in features:
            digest = hashlib.blake2b(feature.encode(), digest_size=8).digest()
            index = int.from_bytes(digest[:4], "little") % DIMENSIONS
            sign = 1.0 if digest[4] & 1 else -1.0
            vector[index] += sign
        return normalise(vector) if any(vector) else _unit(0)


class GeminiEmbedder:
    """gemini-embedding-2 (task prefixes in the text) or -001 (task_type), at 768 dimensions."""

    def __init__(
        self,
        client: genai.Client,
        model: str,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self.client = client
        self.model = model
        self._sleep = sleep

    def embed_documents(self, texts: Sequence[tuple[str | None, str]]) -> list[list[float]]:
        if self._prefixed:
            inputs = [f"title: {heading or 'none'} | text: {text}" for heading, text in texts]
        else:
            inputs = [text for _, text in texts]
        out: list[list[float]] = []
        for start in range(0, len(inputs), BATCH):
            out.extend(self._call(inputs[start : start + BATCH], "RETRIEVAL_DOCUMENT"))
        return out

    def embed_query(self, text: str) -> list[float]:
        query = f"task: search result | query: {text}" if self._prefixed else text
        return self._call([query], "RETRIEVAL_QUERY")[0]

    @property
    def _prefixed(self) -> bool:
        return "embedding-001" not in self.model

    def _call(self, inputs: list[str], task: str) -> list[list[float]]:
        config = types.EmbedContentConfig(
            output_dimensionality=DIMENSIONS,
            **({} if self._prefixed else {"task_type": task}),
        )
        # Wrapping each input in its own Content returns one embedding per input.
        contents = [types.Content(parts=[types.Part(text=text)]) for text in inputs]
        for attempt in range(RATE_LIMIT_RETRIES + 1):
            try:
                response = self.client.models.embed_content(
                    model=self.model, contents=contents, config=config
                )
                break
            except genai.errors.APIError as error:
                if error.code != 429 or attempt == RATE_LIMIT_RETRIES:
                    raise
                wait = retry_delay(error.details, fallback=2.0 * (attempt + 1))
                logger.info("Embeddings rate limited; retrying in %.0f s", wait)
                self._sleep(wait)
        embeddings = response.embeddings or []
        if len(embeddings) != len(inputs):
            raise ValueError(f"expected {len(inputs)} embeddings, got {len(embeddings)}")
        return [normalise(e.values or []) for e in embeddings]


def retry_delay(details: Any, fallback: float) -> float:
    """How long a rate-limited (429) response asks us to wait, in seconds (its RetryInfo, e.g.
    "29s"), capped at MAX_RATE_LIMIT_WAIT_S; `fallback` when it doesn't say."""
    error = details.get("error") if isinstance(details, dict) else None
    infos = error.get("details") if isinstance(error, dict) else None
    for info in infos if isinstance(infos, list) else []:
        delay = info.get("retryDelay") if isinstance(info, dict) else None
        if isinstance(delay, str) and delay.endswith("s"):
            try:
                seconds = float(delay[:-1])
            except ValueError:
                continue
            # A second more than asked: the window has surely moved on by then.
            return min(max(seconds, 0.0) + 1.0, MAX_RATE_LIMIT_WAIT_S)
    return fallback


def _stem(word: str) -> str:
    for suffix in ("ing", "ies", "es", "ed", "s"):
        if len(word) > len(suffix) + 3 and word.endswith(suffix):
            return word[: -len(suffix)] + ("y" if suffix == "ies" else "")
    return word


def _unit(index: int) -> list[float]:
    return [1.0 if i == index else 0.0 for i in range(DIMENSIONS)]
