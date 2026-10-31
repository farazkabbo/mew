"""TTS endpoint: routes to Kokoro (free) or ElevenLabs (premium) based on subscription."""

import logging
from typing import Literal

from fastapi import APIRouter, HTTPException, Request, status
from fastapi.responses import Response
from pydantic import BaseModel, Field

from ..billing.store import BillingStore, MemoryBillingStore, SupabaseBillingStore
from ..config import Settings
from ..deps import Caller, CurrentCaller, SettingsDep
from ..tts.kokoro import DEFAULT_VOICE, KokoroVoice, kokoro_tts

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/tts", tags=["tts"])


class TTSRequest(BaseModel):
    """TTS generation request."""

    text: str = Field(min_length=1, max_length=5000)
    voice_id: str | None = None  # ElevenLabs voice (premium only)
    kokoro_voice: KokoroVoice | None = None  # Kokoro voice (free tier)


def billing_store(request: Request, caller: Caller, settings: Settings) -> BillingStore:
    """Get billing store for subscription check."""
    if caller.is_local:
        store: BillingStore = request.app.state.local_billing
        return store
    if not settings.supabase_url or not settings.supabase_publishable_key:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Billing not configured")
    return SupabaseBillingStore(
        settings.supabase_url,
        api_key=settings.supabase_publishable_key,
        user_token=caller.token,
    )


@router.post("/generate")
async def generate_tts(
    body: TTSRequest,
    request: Request,
    caller: CurrentCaller,
    settings: SettingsDep,
) -> Response:
    """Generate TTS audio, routing to Kokoro (free) or ElevenLabs (premium)."""
    
    # Check subscription status
    store = billing_store(request, caller, settings)
    subscription = store.get_subscription(caller.user_id)
    
    is_premium = (
        subscription is not None
        and subscription.status in ("active", "trialing")
    )
    
    # Route based on subscription
    if is_premium:
        # Premium: use ElevenLabs
        logger.info("Premium user %s: using ElevenLabs", caller.user_id)
        return await _generate_elevenlabs(body, settings)
    else:
        # Free: use Kokoro
        logger.info("Free user %s: using Kokoro AI", caller.user_id)
        return _generate_kokoro(body)


def _generate_kokoro(body: TTSRequest) -> Response:
    """Generate speech with Kokoro AI (free tier)."""
    try:
        voice = body.kokoro_voice or DEFAULT_VOICE
        audio_bytes = kokoro_tts.generate(body.text, voice=voice)
        
        # Return as raw PCM audio (same format as ElevenLabs endpoint expects)
        return Response(
            content=audio_bytes,
            media_type="audio/pcm",
            headers={
                "X-TTS-Engine": "kokoro",
                "X-Voice": voice,
            },
        )
    except Exception as error:
        logger.error("Kokoro TTS generation failed: %s", error)
        raise HTTPException(
            status.HTTP_500_INTERNAL_SERVER_ERROR,
            f"Speech generation failed: {error}",
        ) from error


async def _generate_elevenlabs(body: TTSRequest, settings: Settings) -> Response:
    """Generate speech with ElevenLabs (premium tier)."""
    # This would call ElevenLabs API
    # For now, return placeholder error
    raise HTTPException(
        status.HTTP_501_NOT_IMPLEMENTED,
        "ElevenLabs integration not yet implemented. Use existing /api/tts endpoint for now.",
    )

