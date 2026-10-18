"""Runs checks in worker processes with a hard time limit.

SymPy on untrusted input can be slow or memory-hungry (huge powers, pathological simplify), and a
Python thread can't be interrupted. So checks run in a small process pool: a request that
overruns its budget kills the pool (and its stuck worker) and gets "unknown" results; the next
request starts a fresh pool. On Linux each worker also has an address-space limit.
"""

import logging
import multiprocessing
import sys
import threading
from collections.abc import Callable
from multiprocessing.pool import Pool
from typing import Any

logger = logging.getLogger(__name__)

WORKERS = 2
MEMORY_LIMIT_BYTES = 768 * 1024 * 1024


class CheckTimeoutError(TimeoutError):
    """The check took longer than its budget and was abandoned."""


def limit_memory(limit: int = MEMORY_LIMIT_BYTES) -> None:
    """Caps the worker's address space (POSIX; Windows has no equivalent rlimit)."""
    if sys.platform != "win32":
        import resource

        resource.setrlimit(resource.RLIMIT_AS, (limit, limit))


def _init_checker_worker() -> None:
    limit_memory()
    # Pay SymPy's import cost once per worker, not on the first request.
    from .steps import check_steps

    check_steps(["x=1"])


def _ready(_: int) -> bool:
    """Runs once the worker's initializer (imports included) has finished."""
    return True


class CheckerPool:
    """A pool of sandbox worker processes. Defaults suit the maths checker; course ingestion
    uses its own pool (PDF parsing) with a different initializer."""

    def __init__(
        self,
        workers: int = WORKERS,
        initializer: Callable[..., None] = _init_checker_worker,
        initargs: tuple[Any, ...] = (),
    ) -> None:
        self._workers = workers
        self._initializer = initializer
        self._initargs = initargs
        self._pool: Pool | None = None
        self._lock = threading.Lock()

    def warm(self) -> None:
        """Starts the workers ahead of the first request."""
        self._get()

    def run(self, fn: Callable[..., Any], *args: Any, timeout: float) -> Any:
        pool = self._get()
        result = pool.apply_async(fn, args)
        try:
            return result.get(timeout)
        except multiprocessing.TimeoutError:
            logger.warning("Check exceeded %.1fs; restarting the checker workers", timeout)
            self._reset(pool)
            raise CheckTimeoutError from None

    def close(self) -> None:
        with self._lock:
            if self._pool is not None:
                self._pool.terminate()
                self._pool = None

    def _get(self) -> Pool:
        """The pool, started and warmed. Startup (seconds: SymPy imports) isn't part of any
        check's time budget, so a cold start can't time a check out and restart the pool."""
        with self._lock:
            if self._pool is None:
                # Spawn/forkserver: never fork a process that has server threads running.
                method = "spawn" if sys.platform == "win32" else "forkserver"
                pool = multiprocessing.get_context(method).Pool(
                    self._workers, initializer=self._initializer, initargs=self._initargs
                )
                try:
                    pool.map(_ready, range(self._workers), chunksize=1)
                except Exception:
                    pool.terminate()
                    raise
                self._pool = pool
            return self._pool

    def _reset(self, pool: Pool) -> None:
        with self._lock:
            if self._pool is pool:
                self._pool = None
        pool.terminate()
