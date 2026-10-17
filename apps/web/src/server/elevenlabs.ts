import "server-only";

import { SCRIBE_REALTIME_URL, type SttSession } from "@mew/shared";
import { z } from "zod";

import { elevenLabsEnv } from "./env";
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
