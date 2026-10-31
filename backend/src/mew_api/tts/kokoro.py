"""Kokoro AI TTS integration (open-source, CPU-based)."""

import logging
from typing import Literal

logger = logging.getLogger(__name__)

# Kokoro voice options
KokoroVoice = Literal[
    "af_sarah",     # Female American English (default)
    "af_nicole",    # Female American English (alternative)
    "am_adam",      # Male American English
    "am_michael",   # Male American English
    "bf_emma",      # Female British English
    "bf_isabella",  # Female British English
    "bm_george",    # Male British English
    "bm_lewis",     # Male British English
]

DEFAULT_VOICE: KokoroVoice = "af_sarah"


class KokoroTTS:
    """Kokoro text-to-speech engine.
    
    Lazy-loads the model on first use to avoid slowing down server startup.
    Model is ~340MB and loads in 2-3 seconds.
    """

    def __init__(self) -> None:
        self._kokoro: object | None = None
        self._initialized = False

    def _ensure_initialized(self) -> None:
        """Initialize Kokoro model (lazy load)."""
        if self._initialized:
            return

        try:
            from pykokoro import Kokoro
            logger.info("Initializing Kokoro TTS model (this may take a few seconds)...")
            self._kokoro = Kokoro()
            self._initialized = True
            logger.info("Kokoro TTS model initialized successfully")
        except ImportError as error:
            logger.error("pykokoro package not installed: %s", error)
            raise RuntimeError("Kokoro TTS not available (pykokoro not installed)") from error
        except Exception as error:
            logger.error("Failed to initialize Kokoro TTS: %s", error)
            raise RuntimeError(f"Failed to initialize Kokoro TTS: {error}") from error

    def generate(self, text: str, voice: KokoroVoice = DEFAULT_VOICE) -> bytes:
        """Generate speech from text.
        
        Args:
            text: Text to synthesize (max ~1000 characters recommended)
            voice: Voice ID (see KokoroVoice type for options)
            
        Returns:
            PCM audio bytes (24kHz, mono, 16-bit)
            
        Raises:
            RuntimeError: If Kokoro fails to generate audio
        """
        self._ensure_initialized()
        
        if not text or not text.strip():
            raise ValueError("Text cannot be empty")
        
        if len(text) > 5000:
            logger.warning("Text is very long (%d chars), generation may be slow", len(text))
        
        try:
            # pykokoro's create() method returns PCM audio
            if self._kokoro is None:
                raise RuntimeError("Kokoro model not initialized")
            
            # Type ignore because _kokoro is dynamically loaded
            audio_bytes: bytes = self._kokoro.create(text, voice=voice)  # type: ignore[attr-defined]
            
            logger.debug("Generated %d bytes of audio for %d chars", len(audio_bytes), len(text))
            return audio_bytes
            
        except Exception as error:
            logger.error("Kokoro generation failed: %s", error)
            raise RuntimeError(f"Speech generation failed: {error}") from error

    def warm_up(self) -> None:
        """Pre-load the model (optional, for faster first generation)."""
        try:
            self._ensure_initialized()
            # Generate a tiny sample to warm up the model
            if self._kokoro:
                self._kokoro.create("Hi", voice=DEFAULT_VOICE)  # type: ignore[attr-defined]
                logger.info("Kokoro TTS warmed up")
        except Exception as error:
            logger.warning("Kokoro warm-up failed (non-critical): %s", error)


# Global instance (lazy-initialized)
kokoro_tts = KokoroTTS()

