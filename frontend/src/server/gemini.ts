import "server-only";

import { GoogleGenAI } from "@google/genai";
import { z } from "zod";

import { geminiEnv } from "./env";
import { fakeAnswer, fakeModel } from "./fake-model";

export type ThinkingLevel = "minimal" | "low" | "medium" | "high";

/** Multimodal input: text plus (optionally) base64 images. */
export type InputPart =
  | { type: "text"; text: string }
  | {
      type: "image";
      base64: string;
      mimeType: "image/png" | "image/jpeg";
      /**
       * How finely the model samples it. Gemini 3 bills an image by this, not by its size: low 280
       * tokens, medium 560, high 1120 (the default when unset).
       */
      resolution?: ImageResolution;
    };

export type ImageResolution = "low" | "medium" | "high";

/** Tokens per image at each resolution (Gemini 3; docs/PLAN.md). */
export const IMAGE_TOKENS: Record<ImageResolution, number> = { low: 280, medium: 560, high: 1120 };

/** One call's token counts, as the API reports them. Never any content. */
export type TokenUsage = {
  /** What the call was for (the prompt's name), for the per-turn table. */
  purpose: string;
  model: string;
  input: number;
  cached: number;
  output: number;
  thought: number;
};

type UsageListener = (usage: TokenUsage) => void;
const usageListeners = new Set<UsageListener>();

/** Hears every call's token counts (measurement and budget tests). Returns the unsubscribe. */
export function onUsage(listener: UsageListener): () => void {
  usageListeners.add(listener);
  return () => usageListeners.delete(listener);
}

type ReportedUsage =
  | {
      total_input_tokens?: number | undefined;
      total_cached_tokens?: number | undefined;
      total_output_tokens?: number | undefined;
      total_thought_tokens?: number | undefined;
    }
  | undefined;

function reportUsage(request: GenerationRequest, usage: ReportedUsage): void {
  if (!usage) return;
  const counted: TokenUsage = {
    purpose: request.purpose ?? "unnamed",
    model: request.model,
    input: usage.total_input_tokens ?? 0,
    cached: usage.total_cached_tokens ?? 0,
    output: usage.total_output_tokens ?? 0,
    thought: usage.total_thought_tokens ?? 0,
  };
  console.info(`[usage] ${JSON.stringify(counted)}`);
  for (const listener of usageListeners) listener(counted);
}

type GenerationRequest = {
  model: string;
  system: string;
  input: string | InputPart[];
  thinkingLevel: ThinkingLevel;
  maxOutputTokens: number;
  timeoutMs: number;
  signal?: AbortSignal;
  /** What the call is for, in the usage log (e.g. "circle-ask"). */
  purpose?: string;
};

export type StructuredRequest<T> = GenerationRequest & { schema: z.ZodType<T> };

export class StructuredOutputError extends Error {
  override readonly name = "StructuredOutputError";
}

/** The model said "too many requests" or "overloaded" recently: no request was sent. */
export class ModelBusyError extends Error {
  override readonly name = "ModelBusyError";
  constructor(
    readonly model: string,
    readonly retryAfterMs: number,
  ) {
    super(`${model} is busy; retry in ${Math.ceil(retryAfterMs / 1000)} s`);
  }
}

/** Longest pause after a 429 (a daily quota says "retry in 18h": re-check now and then). */
const MAX_COOLDOWN_MS = 15 * 60_000;
const DEFAULT_429_COOLDOWN_MS = 60_000;
/** "High demand" spikes are usually short. */
const OVERLOADED_COOLDOWN_MS = 20_000;

/** Per model: until when calls fail fast instead of being sent (quota or overload). */
const busyUntil = new Map<string, number>();

/**
 * How long to leave a model alone after this error, or null if the error isn't about load.
 * The SDK's messages start with the HTTP status ("429 Rate limit exceeded … retry in 51s").
 */
export function cooldownFor(error: unknown): number | null {
  const message = error instanceof Error ? error.message : String(error);
  const status = /^(\d{3})\b/.exec(message)?.[1];
  if (status === "503") return OVERLOADED_COOLDOWN_MS;
  if (status !== "429") return null;
  const retry = /retry in (?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?/i.exec(message);
  const ms = retry
    ? ((Number(retry[1] ?? 0) * 60 + Number(retry[2] ?? 0)) * 60 + Number(retry[3] ?? 0)) * 1000
    : 0;
  return Math.min(MAX_COOLDOWN_MS, ms > 0 ? ms : DEFAULT_429_COOLDOWN_MS);
}

function assertNotBusy(model: string, now = Date.now()): void {
  const until = busyUntil.get(model);
  if (until === undefined) return;
  if (until > now) throw new ModelBusyError(model, until - now);
  busyUntil.delete(model);
}

function noteFailure(model: string, error: unknown): void {
  const cooldown = cooldownFor(error);
  if (cooldown === null) return;
  busyUntil.set(model, Date.now() + cooldown);
  console.warn(`[gemini] ${model} busy; pausing calls for ${Math.ceil(cooldown / 1000)} s`);
}

/** For tests: forget every cooldown. */
export function resetModelCooldowns(): void {
  busyUntil.clear();
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
              : {
                  type: "image" as const,
                  data: part.base64,
                  mime_type: part.mimeType,
                  ...(part.resolution && { resolution: part.resolution }),
                },
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
  if (fakeModel()) {
    // Preview and staging only (fake-model.ts): a fixed answer, its usage counted like a real one.
    const text = fakeAnswer(request.purpose ?? "", request.input);
    reportUsage(request, { total_input_tokens: 1000, total_output_tokens: 100 });
    const parsed = request.schema.safeParse(parseJson(text));
    if (parsed.success) return parsed.data;
    throw new StructuredOutputError("The fake model's answer doesn't fit this schema");
  }
  let problem = "no attempt";
  for (let attempt = 0; attempt < 2; attempt++) {
    assertNotBusy(request.model);
    const interaction = await gemini()
      .interactions.create(
        { ...params(request as StructuredRequest<unknown>), stream: false },
        options(request),
      )
      .catch((error: unknown) => {
        noteFailure(request.model, error);
        throw error;
      });
    reportUsage(request, interaction.usage);
    const parsed = request.schema.safeParse(parseJson(interaction.output_text));
    if (parsed.success) return parsed.data;
    problem = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
  }
  throw new StructuredOutputError(`Model output failed validation: ${problem}`);
};

/** Streams the raw JSON text of a structured generation as it is produced (not validated). */
export const streamStructuredText: StreamStructuredText = async function* (request) {
  if (fakeModel()) {
    const text = fakeAnswer(request.purpose ?? "", request.input);
    for (let i = 0; i < text.length; i += 40) yield text.slice(i, i + 40);
    reportUsage(request, { total_input_tokens: 1000, total_output_tokens: 100 });
    return;
  }
  assertNotBusy(request.model);
  try {
    const stream = await gemini().interactions.create(
      { ...params(request), stream: true },
      options(request),
    );
    for await (const event of stream) {
      if (event.event_type === "step.delta" && event.delta.type === "text") yield event.delta.text;
      if (event.event_type === "interaction.completed")
        reportUsage(request, event.interaction.usage);
      if (event.event_type === "error") {
        throw new Error(`Model stream error: ${event.error?.code ?? "unknown"}`);
      }
    }
  } catch (error) {
    noteFailure(request.model, error);
    throw error;
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
