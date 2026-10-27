"""Skills (Screen Coach S5, docs/SCREEN_COACH.md §2.6 and §6).

Who calls what (every route also needs the internal secret):
- the web server, for the desktop app's walkthroughs, with its device token: the owner's skills
  (to pick one to re-check, and its card), and a finished walkthrough's outcome (the server
  worked out the evidence; the rule that coaching is never independent is checked again here
  and by the database);
- the signed-in owner (Clerk token): their skills for the review, and deleting one.
Logs carry ids, kinds and evidence only: never titles.
"""

import logging
from collections.abc import Callable, Sequence
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Header, HTTPException, Request, status

from ..config import Settings
from ..courses.models import Concept
from ..courses.store import CourseStore
from ..courses.supabase_store import SupabaseCourseStore
from ..deps import Caller, CurrentCaller, SettingsDep
from ..skills.models import SkillOut, SkillRecord, SkillsOut, SkillsView
from ..skills.store import MemorySkillStore, SkillStore, SupabaseSkillStore
from ..supabase_rest import StoreError
from .devices import screen_device
from .walkthroughs import _store as walkthrough_store

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/skills", tags=["skills"])

DeviceToken = Annotated[str | None, Header(alias="X-Mew-Device-Token")]


def _call[T](fn: Callable[[], T]) -> T:
    try:
        return fn()
    except PermissionError:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Unauthorized") from None
    except StoreError:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, "Skill storage unavailable") from None


def _unavailable() -> HTTPException:
    return HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Skills aren't configured")


def _concepts_of(courses: CourseStore) -> Callable[[str], Sequence[Concept]]:
    """The student's concepts across their courses (titles are all a skill is matched on)."""

    def concepts(user: str) -> list[Concept]:
        return [
            c
            for course in courses.list_courses(user)
            for c in courses.list_concepts(user, course.id)
        ]

    return concepts


def _service(request: Request, settings: Settings, local: bool) -> SkillStore:
    if local:
        store: MemorySkillStore = request.app.state.local_skills
        return store
    if not settings.supabase_url or settings.supabase_secret_key is None:
        raise _unavailable()
    secret = settings.supabase_secret_key.get_secret_value()
    courses = SupabaseCourseStore(settings.supabase_url, api_key=secret, user_token=None)
    return SupabaseSkillStore(
        settings.supabase_url, api_key=secret, user_token=None, concepts=_concepts_of(courses)
    )


def _owner(request: Request, caller: Caller, settings: Settings) -> SkillStore:
    if caller.is_local:
        store: MemorySkillStore = request.app.state.local_skills
        return store
    if not settings.supabase_url or not settings.supabase_publishable_key:
        raise _unavailable()
    return SupabaseSkillStore(
        settings.supabase_url,
        api_key=settings.supabase_publishable_key,
        user_token=caller.token,
        concepts=lambda _: [],
    )


# ─── The desktop app's walkthroughs ──────────────────────────────────────────────────────────


@router.get("/device")
def device_skills(request: Request, settings: SettingsDep, token: DeviceToken = None) -> SkillsOut:
    device = screen_device(token, request, settings)
    store = _service(request, settings, device.local)
    return SkillsOut(skills=_call(lambda: store.device_list(device.user_id)))


@router.post("/device/record")
def record_skill(
    body: SkillRecord, request: Request, settings: SettingsDep, token: DeviceToken = None
) -> SkillOut:
    """A finished walkthrough's outcome: the skill it built (or re-checked), its evidence and
    its next re-check. Only for a walkthrough of the device's owner that is finished."""
    device = screen_device(token, request, settings)
    walkthroughs = walkthrough_store(request, settings, device)
    walkthrough = _call(lambda: walkthroughs.get(device.user_id, body.walkthrough_id))
    if walkthrough is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    if walkthrough.status != "completed" or walkthrough.kind != body.kind:
        raise HTTPException(status.HTTP_409_CONFLICT, "That walkthrough isn't finished")
    store = _service(request, settings, device.local)
    try:
        skill = _call(lambda: store.record(device.user_id, body))
    except ValueError:
        raise HTTPException(status.HTTP_409_CONFLICT, "Too many skills") from None
    _call(lambda: walkthroughs.set_skill(device.user_id, body.walkthrough_id, skill.id))
    logger.info("Recorded a skill (%s, %s, %s)", skill.id, body.kind, body.evidence)
    return skill


# ─── The owner ───────────────────────────────────────────────────────────────────────────────


@router.get("")
def my_skills(request: Request, caller: CurrentCaller, settings: SettingsDep) -> SkillsView:
    store = _owner(request, caller, settings)
    return SkillsView(skills=_call(lambda: store.views(caller.user_id)))


@router.delete("/{skill_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_skill(
    skill_id: UUID, request: Request, caller: CurrentCaller, settings: SettingsDep
) -> None:
    store = _owner(request, caller, settings)
    if not _call(lambda: store.delete(caller.user_id, skill_id)):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
