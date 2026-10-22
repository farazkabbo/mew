import "server-only";

import { SCRIBE_REALTIME_URL, type SttSession, TTS_SAMPLE_RATE } from "@mew/shared";
import { z } from "zod";

import { elevenLabsEnv, ttsEnv } from "./env";
import { HttpError } from "./http-error";

const API = "https://api.elevenlabs.io";

const TokenResponse = z.object({ token: z.string().min(1).max(512) });

/**
 * Mints a single-use realtime Scribe token so the browser can stream audio straight to
 * ElevenLabs without ever seeing the API key. Tokens are consumed on use and expire in 15 min.
 */
export async function createSttSession(): Promise<SttSession> {
  const { ELEVENLABS_API_KEY, ELEVENLABS_STT_MODEL } = elevenLabsEnv();
  let response: Response;
  try {
    response = await fetch(`${API}/v1/single-use-token/realtime_scribe`, {
      method: "POST",
      headers: { "xi-api-key": ELEVENLABS_API_KEY },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    throw new HttpError(502, "Speech service unreachable");
  }
  if (!response.ok) {
    console.warn("[stt] token request failed with", response.status);
    throw new HttpError(502, "Speech service refused the request");
  }
  const parsed = TokenResponse.safeParse(await response.json().catch(() => null));
  if (!parsed.success) throw new HttpError(502, "Unexpected response from speech service");
  return { token: parsed.data.token, modelId: ELEVENLABS_STT_MODEL, url: SCRIBE_REALTIME_URL };
}

/**
 * Streams speech for `text` as raw PCM (signed 16-bit LE mono, 24 kHz) from ElevenLabs. The
 * caller pipes the body to the browser, which plays it as it arrives.
 */
export async function streamSpeech(
  text: string,
  signal: AbortSignal,
  /** An allowed voice (see voices.ts); defaults to ELEVENLABS_VOICE_ID. */
  voiceId?: string,
): Promise<ReadableStream<Uint8Array>> {
  const { ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ID, ELEVENLABS_TTS_MODEL } = ttsEnv();
  const voice = voiceId ?? ELEVENLABS_VOICE_ID;
  if (!/^[A-Za-z0-9]{8,64}$/.test(voice)) throw new HttpError(400, "Unknown voice");
  const url = new URL(`${API}/v1/text-to-speech/${voice}/stream`);
  url.searchParams.set("output_format", `pcm_${TTS_SAMPLE_RATE}`);

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "xi-api-key": ELEVENLABS_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ text, model_id: ELEVENLABS_TTS_MODEL }),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    });
  } catch {
    throw new HttpError(502, "Speech service unreachable");
  }
  if (!response.ok || !response.body) {
    console.warn("[tts] request failed with", response.status);
    throw speechError(response.status);
  }
  return response.body;
}

/**
 * Explains a refused speech request in terms the student can act on (they see captions
 * instead). 402 is what free ElevenLabs accounts get for Voice Library voices.
 */
function speechError(status: number): HttpError {
  if (status === 402) {
    return new HttpError(
      503,
      "This voice needs a paid ElevenLabs plan. Pick another voice in Settings.",
    );
  }
  if (status === 401 || status === 403) {
    return new HttpError(503, "The voice service refused the server's key.");
  }
  if (status === 429) return new HttpError(429, "The voice service is busy. Try again soon.");
  return new HttpError(502, "Speech service refused the request");
}
