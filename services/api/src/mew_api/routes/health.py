from fastapi import APIRouter

from .. import __version__
from ..schemas import ApiHealth

router = APIRouter(tags=["health"])


@router.get("/health")
async def health() -> ApiHealth:
    """Public liveness probe (used by Render and the web app). Reveals nothing but the version."""
    return ApiHealth(version=__version__)
