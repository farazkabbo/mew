import "server-only";

import {
  enforceMewRules,
  fallbackMew,
  MEW_GATE_PROMPT,
  type MewDecisionResponse,
  type MewInput,
  MewOutput,
  prefilterMew,
  renderMewGateInput,
} from "@mew/shared";

import { geminiEnv } from "./env";
import { type GenerateStructured, generateStructured } from "./gemini";

/** The gate must answer well inside the 400 ms target; past this the student has moved on. */
const GATE_TIMEOUT_MS = 2500;

/**
 * Mew v1: decides whether (and how) the tutor should respond. Obvious cases are decided by
 * rule; the rest by the gate model. Any failure degrades to silence (or to answering, when the
 * student explicitly summoned Mew).
 */
export async function classifyMew(
  input: MewInput,
  generate: GenerateStructured = generateStructured,
): Promise<MewDecisionResponse> {
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);

  const rule = prefilterMew(input);
  if (rule) return { output: rule, source: "rule", latencyMs: elapsed() };

  try {
    const output = await generate({
      model: geminiEnv().GEMINI_GATE_MODEL,
      system: MEW_GATE_PROMPT.system,
      input: renderMewGateInput(input),
      schema: MewOutput,
      thinkingLevel: "minimal",
      maxOutputTokens: 256,
      timeoutMs: GATE_TIMEOUT_MS,
    });
    return { output: enforceMewRules(input, output), source: "model", latencyMs: elapsed() };
  } catch (error) {
    console.warn("[mew] gate unavailable:", error instanceof Error ? error.message : error);
    return { output: fallbackMew(input), source: "fallback", latencyMs: elapsed() };
  }
}
