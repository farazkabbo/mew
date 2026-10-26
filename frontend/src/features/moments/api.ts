import {
  ClipView,
  type MomentCheckAnswer,
  MomentCheckResult,
  MomentChecksDue,
  MomentSuggestions,
  TTS_SAMPLE_RATE,
} from "@mew/shared";
import { z } from "zod";

/** A failed moments request, with the server's (safe, user-facing) message. */
export class MomentApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "MomentApiError";
  }
}

async function call<T>(url: string, schema: z.ZodType<T>, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, cache: "no-store" });
  } catch {
    throw new MomentApiError("Can't reach the server. Check your connection.", 0);
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
    const message = typeof body?.error === "string" ? body.error : "Something went wrong.";
    throw new MomentApiError(message, response.status);
  }
  return schema.parse(response.status === 204 ? undefined : await response.json());
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

/** Saved moments (K8, docs/NOTEBOOKS_K.md §4.6–4.7): their checks, filing, and their voice. */
export const momentsApi = {
  /** Every active check (no keys), soonest due first. */
  checks: () => call("/api/moments/checks", MomentChecksDue),
  answer: (id: string, answer: MomentCheckAnswer) =>
    call(`/api/moments/checks/${id}/answer`, MomentCheckResult, json("POST", answer)),
  /** "Quiz me on things I save" turned off, and "clear them" too. */
  clearChecks: () => call("/api/moments/checks", z.undefined(), { method: "DELETE" }),
  /** Unsorted's "File these": a place for each waiting moment. */
  suggestions: (clipIds: readonly string[]) =>
    call("/api/moments/suggestions", MomentSuggestions, json("POST", { clipIds })),
  /** A moment filed from the notebook: the server's copy follows, and filing learns from it. */
  moved: (clipId: string, nodeId: string) =>
    call(`/api/moments/${clipId}/move`, z.undefined(), json("POST", { nodeId })),
  clip: (clipId: string) => call(`/api/clips/${clipId}`, ClipView),
};

/** A clip's picture, as the notebook and the Moments list show it. */
export const clipImageUrl = (clipId: string) => `/api/clips/${clipId}/image`;

/** A moment's voice for one step, as played when it was explained (16-bit PCM at 24 kHz). */
export function momentAudioUrl(clipId: string, turn: number, step: number): string {
  return `/api/moments/${clipId}/audio/${turn}/${step}`;
}

/** Keeps one step's voice with its moment (best effort: a replay without it uses captions). */
export async function saveMomentAudio(
  clipId: string,
  turn: number,
  step: number,
  pcm: Uint8Array,
): Promise<boolean> {
  const response = await fetch(momentAudioUrl(clipId, turn, step), {
    method: "PUT",
    headers: { "Content-Type": "audio/L16" },
    body: pcm as BodyInit,
    cache: "no-store",
  }).catch(() => null);
  return response?.ok ?? false;
}

/** One step's stored voice, or null (none was kept, or it can't be reached). */
export async function loadMomentAudio(
  clipId: string,
  turn: number,
  step: number,
  signal?: AbortSignal,
): Promise<ReadableStream<Uint8Array> | null> {
  const response = await fetch(momentAudioUrl(clipId, turn, step), {
    cache: "no-store",
    ...(signal && { signal }),
  }).catch(() => null);
  return response?.ok && response.body ? response.body : null;
}

export const MOMENT_AUDIO_RATE = TTS_SAMPLE_RATE;
