import "server-only";

import {
  clampNote,
  LIVE_MARK_PROMPT,
  type LiveMarkRequest,
  LiveMarkResponse,
  renderLiveMarkInput,
  unsafeReasons,
} from "@mew/shared";

import { geminiEnv } from "./env";
import { type GenerateStructured, generateStructured } from "./gemini";

const TIMEOUT_MS = 6_000;

/**
 * A margin note for a line of writing (K9 §7.1, writing subjects at the Coach level): 1–4 words
 * pointing at what's weak, from the fast verifier model, or null. Notes that fail the safety check
 * are dropped, and so is anything longer than four words.
 */
export async function liveMarkNote(
  request: LiveMarkRequest,
  generate: GenerateStructured = generateStructured,
): Promise<string | null> {
  const { note } = await generate({
    model: geminiEnv().GEMINI_VERIFIER_MODEL,
    system: LIVE_MARK_PROMPT.system,
    input: [{ type: "text", text: renderLiveMarkInput(request) }],
    schema: LiveMarkResponse,
    thinkingLevel: "low",
    maxOutputTokens: 256,
    timeoutMs: TIMEOUT_MS,
  });
  const clamped = note ? clampNote(note) : null;
  return clamped && unsafeReasons(clamped).length === 0 ? clamped : null;
}
