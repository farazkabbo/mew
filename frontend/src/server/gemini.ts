import "server-only";

import { GoogleGenAI } from "@google/genai";
import { z } from "zod";

import { geminiEnv } from "./env";

export type ThinkingLevel = "minimal" | "low" | "medium" | "high";

/** Multimodal input: text plus (optionally) base64 PNG images. */
export type InputPart = { type: "text"; text: string } | { type: "image"; png: string };

type GenerationRequest = {
  model: string;
  system: string;
  input: string | InputPart[];
  thinkingLevel: ThinkingLevel;
  maxOutputTokens: number;
  timeoutMs: number;
  signal?: AbortSignal;
};

export type StructuredRequest<T> = GenerationRequest & { schema: z.ZodType<T> };

export class StructuredOutputError extends Error {
  override readonly name = "StructuredOutputError";
}

/** Signature shared by the real generator and test doubles. */
export type GenerateStructured = <T>(request: StructuredRequest<T>) => Promise<T>;
export type StreamStructuredText = (request: StructuredRequest<unknown>) => AsyncIterable<string>;

let client: GoogleGenAI | undefined;

function gemini(): GoogleGenAI {
  client ??= new GoogleGenAI({ apiKey: geminiEnv().GEMINI_API_KEY });
  return client;
}

/**
 * Parameters shared by every call. Interactions are never stored by the API (`store: false`):
 * transcripts and handwriting are student data.
 */
function params(request: StructuredRequest<unknown>) {
  return {
    model: request.model,
    system_instruction: request.system,
    input:
      typeof request.input === "string"
        ? request.input
        : request.input.map((part) =>
            part.type === "text"
              ? part
              : { type: "image" as const, data: part.png, mime_type: "image/png" },
          ),
    store: false,
    response_format: {
      type: "text" as const,
      mime_type: "application/json",
      schema: toGeminiSchema(request.schema),
    },
    generation_config: {
      thinking_level: request.thinkingLevel,
      max_output_tokens: request.maxOutputTokens,
    },
  };
}

function options(request: GenerationRequest) {
  return {
    timeout_ms: request.timeoutMs,
    retries: { strategy: "none" as const },
    ...(request.signal && { fetch_options: { signal: request.signal } }),
  };
}

/**
 * One structured (JSON) generation. The output is validated against `schema`; invalid output is
 * retried once, then reported as a StructuredOutputError so callers can degrade gracefully.
 */
export const generateStructured: GenerateStructured = async <T>(request: StructuredRequest<T>) => {
  let problem = "no attempt";
  for (let attempt = 0; attempt < 2; attempt++) {
    const interaction = await gemini().interactions.create(
      { ...params(request as StructuredRequest<unknown>), stream: false },
      options(request),
    );
    const parsed = request.schema.safeParse(parseJson(interaction.output_text));
    if (parsed.success) return parsed.data;
    problem = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
  }
  throw new StructuredOutputError(`Model output failed validation: ${problem}`);
};

/** Streams the raw JSON text of a structured generation as it is produced (not validated). */
export const streamStructuredText: StreamStructuredText = async function* (request) {
  const stream = await gemini().interactions.create(
    { ...params(request), stream: true },
    options(request),
  );
  for await (const event of stream) {
    if (event.event_type === "step.delta" && event.delta.type === "text") yield event.delta.text;
    if (event.event_type === "error") {
      throw new Error(`Model stream error: ${event.error?.code ?? "unknown"}`);
    }
  }
};

export function parseJson(text: string | undefined): unknown {
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

/**
 * Besides dropping unsupported keywords: `oneOf` (zod's discriminated unions, e.g. board
 * actions) becomes `anyOf`, which Gemini supports; the variants have distinct `type` tags, so
 * it means the same. (Dropping it left the model with no idea what an action looks like.)
 *
 * Array bounds (minItems/maxItems) are not sent: combined with unions or nested arrays they make
 * Gemini reject the schema (400 "invalid argument", verified against the API). The prompts state
 * the limits and zod still enforces them.
 */
function prune(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(prune);
  if (typeof node !== "object" || node === null) return node;
  const out: Record<string, unknown> = {};
  for (const [rawKey, value] of Object.entries(node)) {
    const key = rawKey === "oneOf" ? "anyOf" : rawKey;
    // `const` isn't supported; a one-value enum says the same (discriminated-union tags).
    if (key === "const") {
      out.enum = [value];
      continue;
    }
    if (!SUPPORTED_KEYWORDS.has(key)) continue;
    // `properties` and `$defs` map names to schemas; their keys are names, not keywords.
    out[key] =
      key === "properties" || key === "$defs"
        ? Object.fromEntries(Object.entries(value as object).map(([k, v]) => [k, prune(v)]))
        : prune(value);
  }
  return out;
}
