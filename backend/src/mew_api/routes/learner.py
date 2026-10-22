"""Learner model (M8): attempts with evidence, review cards and the review queue.

The web server runs the scheduler (FSRS) and sends each updated card; this service checks that
the concept belongs to the caller's course and stores it, scoped to the caller like courses.
"""

from datetime import UTC, datetime
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Query, Request, status

from ..courses.store import CourseNotFoundError
from ..deps import CurrentCaller, SettingsDep
from ..learner.models import MAX_DUE, AttemptWrite, DueCards, ExploredWrite, LearnerData
from .courses import _call, _require, _user_store

router = APIRouter(tags=["learner"])


@router.get("/courses/{course_id}/learner")
def learner_data(
    course_id: UUID, request: Request, caller: CurrentCaller, settings: SettingsDep
) -> LearnerData:
    """The course's attempts (oldest first) and review cards."""
    store = _user_store(request, caller, settings)

    def get() -> LearnerData:
        _require(store, caller.user_id, course_id)
        return store.learner_data(caller.user_id, course_id)

    return _call(get)


@router.post("/courses/{course_id}/attempts", status_code=status.HTTP_204_NO_CONTENT)
def add_attempt(
    course_id: UUID,
    body: AttemptWrite,
    request: Request,
    caller: CurrentCaller,
    settings: SettingsDep,
) -> None:
    """Logs one answer and saves the concept's rescheduled review card."""
    store = _user_store(request, caller, settings)
    user = caller.user_id

    def add() -> None:
        if not store.has_concept(user, course_id, body.concept_id):
            raise CourseNotFoundError(body.concept_id)
        store.add_attempt(user, course_id, body)

    _call(add)


@router.post("/courses/{course_id}/explored", status_code=status.HTTP_204_NO_CONTENT)
def explored(
    course_id: UUID,
    body: ExploredWrite,
    request: Request,
    caller: CurrentCaller,
    settings: SettingsDep,
) -> None:
    """The student opened a concept's lesson: start its review card (once)."""
    store = _user_store(request, caller, settings)
    user = caller.user_id

    def start() -> None:
        if not store.has_concept(user, course_id, body.concept_id):
            raise CourseNotFoundError(body.concept_id)
        store.start_card(user, course_id, body.concept_id, body.card)

    _call(start)


@router.get("/learner/due")
def due_cards(
    request: Request,
    caller: CurrentCaller,
    settings: SettingsDep,
    limit: Annotated[int, Query(ge=1, le=MAX_DUE)] = MAX_DUE,
) -> DueCards:
    """Concepts due for review now, across all of the caller's courses (soonest first)."""
    store = _user_store(request, caller, settings)
    now = datetime.now(UTC)
    return DueCards(cards=_call(lambda: store.due_cards(caller.user_id, now, limit)))
