import "server-only";

import { createHash } from "node:crypto";

import type { InputPart, StreamStructuredText } from "./gemini";
import { LIMITS } from "./limits";
import { getJson, resetRedis, setJson } from "./redis";

/**
 * Reuses an answer when the same question comes back about the same picture (docs/PLAN.md,
 * Part 4.9): asking twice, or a retry after a dropped connection, costs no second model call.
 * The key covers everything the model saw (prompt, words, images), so two questions share an
 * answer only when their whole input is identical. Kept in this process for 10 minutes and in
 * Redis for 7 days (docs/LAUNCH_LIMITS.md); a reused answer still counts as a question.
 */
const TTL_MS = 10 * 60_000;
const MAX_ENTRIES = 200;

const answers = new Map<string, { chunks: string[]; at: number }>();

function keyOf(request: Parameters<StreamStructuredText>[0]): string {
  const hash = createHash("sha256");
  hash.update(`${request.model}\u0000${request.system}\u0000`);
  const parts: readonly (string | InputPart)[] =
    typeof request.input === "string" ? [request.input] : request.input;
  for (const part of parts) {
    if (typeof part === "string") hash.update(part);
    else if (part.type === "text") hash.update(`t\u0000${part.text}`);
    else hash.update(`i\u0000${part.resolution ?? ""}\u0000${part.base64}`);
    hash.update("\u0000");
  }
  return hash.digest("hex");
}

/** `stream`, remembering each complete answer and replaying it for an identical input. */
export function reusingAnswers(
  stream: StreamStructuredText,
  now: () => number = Date.now,
): StreamStructuredText {
  return async function* (request) {
    const key = keyOf(request);
    const kept = answers.get(key);
    // Here first (this process, 10 minutes), then Redis (every instance, 7 days).
    const fresh = kept && now() - kept.at < TTL_MS ? kept.chunks : null;
    const reuse = fresh ?? (await getJson<string[]>(`answer:${key}`));
    if (reuse) {
      console.info(
        `[usage] ${JSON.stringify({ purpose: request.purpose ?? "unnamed", reused: true })}`,
      );
      yield* reuse;
      return;
    }
    const chunks: string[] = [];
    for await (const chunk of stream(request)) {
      chunks.push(chunk);
      yield chunk;
    }
    // Only a stream that ran to its end is kept (a cancelled one never gets here).
    answers.delete(key);
    answers.set(key, { chunks, at: now() });
    if (answers.size > MAX_ENTRIES) answers.delete(answers.keys().next().value ?? "");
    // The model's words only: no account, no device, nothing that says whose question it was.
    await setJson(`answer:${key}`, chunks, LIMITS.cacheTtlS);
  };
}

/** Forgets every kept answer (tests). */
export function forgetAnswers(): void {
  answers.clear();
  resetRedis();
}
