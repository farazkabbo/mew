"""Checkers for students' work (M5). Stateless: no user data is stored or read."""

import logging

from fastapi import APIRouter, Request

from ..checker.sandbox import CheckerPool, CheckTimeoutError
from ..checker.steps import check_steps
from ..schemas import ApiMathCheckRequest, ApiMathCheckResponse, ApiStepResult

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/check", tags=["check"])

#: Wall-clock budget for one request's checks, including a worker restart if needed.
CHECK_TIMEOUT_S = 4.0


@router.post("/math")
def check_math(body: ApiMathCheckRequest, request: Request) -> ApiMathCheckResponse:
    """Is each line a correct step from the one before? Verified with SymPy, never guessed."""
    pool: CheckerPool = request.app.state.checker
    try:
        raw = pool.run(check_steps, list(body.steps), timeout=CHECK_TIMEOUT_S)
    except CheckTimeoutError:
        raw = [
            {"index": i, "verdict": "unknown", "reason": "timeout"} for i in range(len(body.steps))
        ]
    return ApiMathCheckResponse(results=[ApiStepResult.model_validate(r) for r in raw])
