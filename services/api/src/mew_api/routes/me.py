from fastapi import APIRouter

from ..deps import CurrentPrincipal
from ..schemas import ApiWhoAmI

router = APIRouter(tags=["auth"])


@router.get("/me")
def me(principal: CurrentPrincipal) -> ApiWhoAmI:
    """Echoes the verified identity; the web status page uses it to test the auth chain."""
    return ApiWhoAmI(user_id=principal.user_id)
