import "server-only";

import {
  type CircleStreamEvent,
  type DestinationSource,
  FilingMethod,
  type FilingNote,
  MOMENT_LIMITS,
  type ResolvedDestination,
  type SavedDestination,
  sourceKey,
  Subject,
} from "@mew/shared";
import { z } from "zod";

import { apiFetch } from "./api-client";
import { stickyDestination } from "./destinations";

/**
 * Auto-filing (K8, docs/NOTEBOOKS_K.md §4.6): when the student didn't say where a moment goes, the
 * API service decides from what the answer said it's about (its subject and concept hints, no
 * extra model call) and the student's own tree, course passages, earlier moments and corrections:
 * source memory, content match, subject match, this server's sticky place, or Unsorted. Only
 * ids, scores and the method are logged (by the API).
 */

const Place = z.object({
  nodeId: z.uuid(),
  path: z.array(z.string().min(1).max(200)).min(1).max(3),
});

const FilingResponse = z.object({
  method: FilingMethod.exclude(["spoken"]),
  nodeId: z.uuid(),
  path: Place.shape.path,
  score: z.number().min(0).max(1),
  matched: z.string().max(80).nullish(),
  alternatives: z.array(Place).max(MOMENT_LIMITS.alternatives),
  newNotebook: z.string().min(1).max(80).nullish(),
});
type FilingResponse = z.infer<typeof FilingResponse>;

export type Filed = {
  destination: ResolvedDestination;
  filing: FilingNote;
};

export type FilingInput = {
  userId: string;
  source: DestinationSource | undefined;
  subject: z.infer<typeof Subject> | null;
  hints: readonly string[];
};

const place = (p: z.infer<typeof Place>, confidence: number): ResolvedDestination => ({
  nodeId: p.nodeId,
  path: p.path,
  page: { kind: "from_screen" },
  confidence,
  method: "filed",
});

/** What the toast says after the place: why it went there, or the question Unsorted asks. */
export function filingNoteText(
  method: FilingResponse["method"],
  matched?: string | null,
): string | null {
  switch (method) {
    case "content_match":
      return matched ? `matched “${matched}”`.slice(0, MOMENT_LIMITS.noteChars) : null;
    case "source_memory":
      return "where moments from here go";
    case "subject_match":
      return "pick a chapter?";
    case "unsorted":
      return "Where should this go?";
    case "sticky":
      return null;
  }
}

/** Where an unspoken moment goes, or null when the API can't say (the device decides, as K3). */
export async function fileMoment(deviceToken: string, input: FilingInput): Promise<Filed | null> {
  const sticky = stickyDestination(input.userId, input.source);
  try {
    const filed = await apiFetch("/v1/moments/file", FilingResponse, {
      method: "POST",
      headers: { "X-Mew-Device-Token": deviceToken },
      body: {
        sourceKey: sourceKey(input.source),
        subject: input.subject,
        hints: input.hints.slice(0, MOMENT_LIMITS.hints).map((h) => h.slice(0, 80)),
        stickyNodeId: sticky?.nodeId ?? null,
      },
      timeoutMs: 5_000,
    });
    return {
      destination: place(filed, filed.score),
      filing: {
        method: filed.method,
        note: filingNoteText(filed.method, filed.matched),
        alternatives: filed.alternatives.map((a) => place(a, 0)),
        newNotebook: filed.newNotebook ?? null,
      },
    };
  } catch {
    return null; // best effort: never holds up an answer or a save
  }
}

/** The `destination` event the card shows (sent before the answer's `done`). */
export function filingEvent(filed: Filed): CircleStreamEvent {
  return {
    type: "destination",
    phrase: null,
    resolution: { kind: "resolved", destination: filed.destination },
    filing: filed.filing,
  };
}

/** Where a clip saved without a place goes (K8: no longer "the notebook open in Neb"). */
export function savedDestination(filed: Filed): SavedDestination {
  return {
    nodeId: filed.destination.nodeId,
    page: { kind: "from_screen" },
    path: filed.destination.path,
  };
}
