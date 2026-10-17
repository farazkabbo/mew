import "server-only";

import { GoogleGenAI } from "@google/genai";
import { z } from "zod";

import { geminiEnv } from "./env";

export type ThinkingLevel = "minimal" | "low" | "medium" | "high";

export type StructuredRequest<T> = {
  model: string;
  system: string;
  input: string;
  schema: z.ZodType<T>;
  thinkingLevel: ThinkingLevel;
  maxOutputTokens: number;
  timeoutMs: number;
};

export class StructuredOutputError extends Error {
  override readonly name = "StructuredOutputError";
}

/** Signature shared by the real generator and test doubles. */
export type GenerateStructured = <T>(request: StructuredRequest<T>) => Promise<T>;

let client: GoogleGenAI | undefined;

function gemini(): GoogleGenAI {
  client ??= new GoogleGenAI({ apiKey: geminiEnv().GEMINI_API_KEY });
  return client;
}

/**
 * One structured (JSON) generation. The output is validated against `schema`; invalid output is
 * retried once, then reported as a StructuredOutputError so callers can degrade gracefully.
 * Interactions are never stored by the API (`store: false`): transcripts are student data.
 */
export const generateStructured: GenerateStructured = async <T>(request: StructuredRequest<T>) => {
  const responseSchema = toGeminiSchema(request.schema);
  let problem = "no attempt";
  for (let attempt = 0; attempt < 2; attempt++) {
    const interaction = await gemini().interactions.create(
      {
        model: request.model,
        system_instruction: request.system,
        input: request.input,
        store: false,
        response_format: { type: "text", mime_type: "application/json", schema: responseSchema },
        generation_config: {
          thinking_level: request.thinkingLevel,
          max_output_tokens: request.maxOutputTokens,
        },
      },
      { timeout_ms: request.timeoutMs, retries: { strategy: "none" } },
    );
    const parsed = request.schema.safeParse(parseJson(interaction.output_text));
    if (parsed.success) return parsed.data;
    problem = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
  }
  throw new StructuredOutputError(`Model output failed validation: ${problem}`);
};

function parseJson(text: string | undefined): unknown {
  try {
    return text === undefined ? undefined : (JSON.parse(text) as unknown);
  } catch {
    return undefined;
  }
}

/** JSON Schema keywords Gemini's structured output supports; others are dropped (zod still validates them). */
const SUPPORTED_KEYWORDS = new Set([
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "prefixItems",
  "minItems",
  "maxItems",
  "enum",
  "format",
  "minimum",
  "maximum",
  "anyOf",
  "description",
  "title",
  "$ref",
  "$defs",
]);

/** Converts a zod schema into the JSON Schema subset Gemini accepts. */
export function toGeminiSchema(schema: z.ZodType): Record<string, unknown> {
  return prune(z.toJSONSchema(schema)) as Record<string, unknown>;
}

function prune(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(prune);
  if (typeof node !== "object" || node === null) return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (!SUPPORTED_KEYWORDS.has(key)) continue;
    // `properties` and `$defs` map names to schemas; their keys are names, not keywords.
    out[key] =
      key === "properties" || key === "$defs"
        ? Object.fromEntries(Object.entries(value as object).map(([k, v]) => [k, prune(v)]))
        : prune(value);
  }
  return out;
}
