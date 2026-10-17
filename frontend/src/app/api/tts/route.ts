import { TTS_SAMPLE_RATE, TtsRequest } from "@mew/shared";

import { streamSpeech } from "@/server/elevenlabs";
import { ttsEnv } from "@/server/env";
import { assertSameOrigin, handle, readJson, requireUserId } from "@/server/http";
import { enforceRateLimit, RATE_RULES } from "@/server/rate-limit";

const MAX_BODY_BYTES = 4096;

/**
 * Speaks the tutor's reply: proxies ElevenLabs' streaming TTS as raw PCM so the API key stays on
 * the server. Budgets are in characters, which is how speech is billed.
 */
export const POST = handle(async (request: Request) => {
  assertSameOrigin(request);
  const userId = await requireUserId();
  const { text } = await readJson(request, TtsRequest, MAX_BODY_BYTES);
  ttsEnv();
  enforceRateLimit(
    userId,
    { ttsCharsPerMinute: RATE_RULES.ttsCharsPerMinute, ttsCharsDaily: RATE_RULES.ttsCharsDaily },
    { cost: text.length },
  );

  // Cancelling the request (barge-in) aborts the upstream synthesis too.
  const audio = await streamSpeech(text, request.signal);
  return new Response(audio, {
    headers: {
      "Content-Type": `audio/pcm;rate=${TTS_SAMPLE_RATE};encoding=s16le;channels=1`,
      "Cache-Control": "no-store",
    },
  });
});
