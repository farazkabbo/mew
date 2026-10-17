import "server-only";

import { SCRIBE_REALTIME_URL, type SttSession, TTS_SAMPLE_RATE } from "@mew/shared";
import { z } from "zod";

import { elevenLabsEnv, ttsEnv } from "./env";
import { HttpError } from "./http";

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
): Promise<ReadableStream<Uint8Array>> {
  const { ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ID, ELEVENLABS_TTS_MODEL } = ttsEnv();
  const url = new URL(`${API}/v1/text-to-speech/${ELEVENLABS_VOICE_ID}/stream`);
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
    throw new HttpError(502, "Speech service refused the request");
  }
  return response.body;
}
