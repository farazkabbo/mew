import "server-only";

import {
  type CircleAskRequest,
  type CircleStreamEvent,
  DESTINATION_FALLBACK_PROMPT,
  DESTINATION_LIMITS,
  type DestinationNode,
  type DestinationResolution,
  type DestinationSource,
  type DestinationTree,
  looksDescriptive,
  NotebookTreeView,
  renderDestinationInput,
  type ResolvedDestination,
  resolveDestination,
  type SavedDestination,
  sourceKey,
  splitDestination,
} from "@mew/shared";
import { z } from "zod";

import { ApiError, apiFetch } from "./api-client";
import { geminiEnv } from "./env";
import { type GenerateStructured, generateStructured } from "./gemini";
import { HttpError } from "./http-error";

/**
 * "Save it to my Physics notebook, chapter 5" for the desktop app (K3 §4.3): the student's tree is
 * read with the device token (titles only), the words are resolved by the shared resolver, and the
 * gate model is asked to pick an id only when the words describe instead of name. Kept here, in
 * this process's memory (like the rate limiter): each student's recent destinations (small
 * boosts) and the sticky destination per source (2 h). Logs carry counts and methods only, never
 * titles or words.
 */

const FALLBACK_TIMEOUT_MS = 2500;
/** At most this many places go to the model (most students have far fewer). */
const FALLBACK_PLACES = 200;
const RECENT = 5;
/** Students remembered at once (oldest dropped first). */
const MAX_USERS = 5_000;

type Sticky = { destination: ResolvedDestination; at: number };
type Memory = { recent: string[]; sticky: Map<string, Sticky> };

const memories = new Map<string, Memory>();

function memoryOf(userId: string): Memory {
  let memory = memories.get(userId);
  if (!memory) {
    if (memories.size >= MAX_USERS) {
      const oldest = memories.keys().next().value;
      if (oldest !== undefined) memories.delete(oldest);
    }
    memory = { recent: [], sticky: new Map() };
    memories.set(userId, memory);
  }
  return memory;
}

/** A save happened: its destination is recent, and sticky for its source (§4.3 step 7). */
export function rememberDestination(
  userId: string,
  destination: SavedDestination,
  source: DestinationSource | undefined,
  now = Date.now(),
): void {
  if (destination.create) return; // made on the device first: its id comes later
  const memory = memoryOf(userId);
  memory.recent = [
    destination.nodeId,
    ...memory.recent.filter((id) => id !== destination.nodeId),
  ].slice(0, RECENT);
  const key = sourceKey(source);
  if (!key || !destination.path) return;
  memory.sticky.set(key, {
    destination: {
      nodeId: destination.nodeId,
      path: destination.path,
      page: destination.page,
      confidence: 1,
      method: "sticky",
    },
    at: now,
  });
  // Old ones go.
  for (const [k, sticky] of memory.sticky) {
    if (now - sticky.at > DESTINATION_LIMITS.stickyMs) memory.sticky.delete(k);
  }
}

/** The place this source's moments went in the last 2 h, if any. */
export function stickyDestination(
  userId: string,
  source: DestinationSource | undefined,
  now = Date.now(),
): ResolvedDestination | null {
  const key = sourceKey(source);
  const sticky = key ? memories.get(userId)?.sticky.get(key) : undefined;
  if (!sticky || now - sticky.at > DESTINATION_LIMITS.stickyMs) return null;
  return sticky.destination;
}

/** Forgets everything (tests). */
export function forgetDestinations(): void {
  memories.clear();
}

/** The device owner's tree, titles and places only (FastAPI checks the token again). */
export async function deviceTree(deviceToken: string): Promise<DestinationNode[]> {
  try {
    const tree = await apiFetch("/v1/notebooks/device-tree", NotebookTreeView, {
      headers: { "X-Mew-Device-Token": deviceToken },
      timeoutMs: 5_000,
    });
    return tree.nodes;
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    if (error.status === 401) throw new HttpError(401, "Unauthorized");
    throw new HttpError(error.status === null ? 503 : 502, "Your notebooks aren't reachable");
  }
}

/** The picker's places: every live notebook, chapter and section, in tree order. */
export function placesOf(nodes: readonly DestinationNode[]): DestinationTree["places"] {
  const live = nodes.filter((n) => n.deletedAt === null || n.deletedAt === undefined);
  const byParent = new Map<string | null, DestinationNode[]>();
  for (const node of live) {
    const parent = live.some((n) => n.id === node.parentId) ? node.parentId : null;
    byParent.set(parent, [...(byParent.get(parent) ?? []), node]);
  }
  const places: DestinationTree["places"] = [];
  const walk = (parent: string | null, path: string[]) => {
    const children = [...(byParent.get(parent) ?? [])].sort((a, b) =>
      a.position < b.position ? -1 : a.position > b.position ? 1 : 0,
    );
    for (const child of children) {
      const childPath = [...path, child.title.slice(0, 200)];
      if (places.length < 500) places.push({ nodeId: child.id, path: childPath });
      if (childPath.length < 3) walk(child.id, childPath);
    }
  };
  walk(null, []);
  return places;
}

/**
 * Circle & Ask (§4.2): "…and save it to Physics chapter 5" is taken out of the question before the
 * model sees it, and resolved; with no words about a place, the source's sticky one (if any) is
 * offered. The event goes first, so the card shows "Saving to: …" at once.
 */
export async function circleDestination(
  request: CircleAskRequest,
  userId: string,
  deviceToken: string,
  deps: ResolveDeps & { tree: (token: string) => Promise<DestinationNode[]> } = {
    ...defaultDeps,
    tree: deviceTree,
  },
): Promise<{ request: CircleAskRequest; event: CircleStreamEvent | null }> {
  const question = request.question;
  const source = { app: request.app, ...request.source };
  if (question.source === "voice" || question.source === "typed") {
    const split = splitDestination(question.text);
    const nodes = split ? await deps.tree(deviceToken).catch(() => null) : null;
    if (split && nodes) {
      const resolution = await resolveForUser(userId, split.phrase, nodes, deps);
      // "How do I save this to PDF?" names no place of theirs: it stays the question.
      if (resolution.kind !== "none" || split.cued) {
        return {
          request: {
            ...request,
            question: split.question
              ? { source: question.source, text: split.question }
              : { source: "none" },
          },
          event: { type: "destination", phrase: split.phrase, resolution },
        };
      }
    }
  }
  const sticky = stickyDestination(userId, source);
  return {
    request,
    event: sticky
      ? { type: "destination", phrase: null, resolution: { kind: "resolved", destination: sticky } }
      : null,
  };
}

export type ResolveDeps = { generate: GenerateStructured; log: (line: string) => void };
const defaultDeps: ResolveDeps = {
  generate: generateStructured,
  log: (line) => console.info(line),
};

/**
 * Where the words go, for this student: the shared resolver, then (only for descriptions) the
 * gate model, choosing an id from their own places or none, checked against those places.
 */
export async function resolveForUser(
  userId: string,
  phrase: string,
  nodes: readonly DestinationNode[],
  deps: ResolveDeps = defaultDeps,
): Promise<DestinationResolution> {
  const recentNodeIds = memories.get(userId)?.recent ?? [];
  const result = resolveDestination(phrase, nodes, { recentNodeIds });
  if (result.kind !== "none" || !looksDescriptive(phrase)) {
    deps.log(`[destinations] resolved: ${result.kind}`);
    return result;
  }
  const places = placesOf(nodes).slice(0, FALLBACK_PLACES);
  if (places.length === 0) return result;
  const ids = places.map((p) => p.nodeId) as [string, ...string[]];
  try {
    const answer = await deps.generate({
      model: geminiEnv().GEMINI_GATE_MODEL,
      system: DESTINATION_FALLBACK_PROMPT.system,
      input: renderDestinationInput(
        phrase,
        places.map((p) => ({ id: p.nodeId, path: p.path })),
      ),
      schema: z.object({ nodeId: z.enum(ids).nullable() }),
      thinkingLevel: "minimal",
      maxOutputTokens: 128,
      timeoutMs: FALLBACK_TIMEOUT_MS,
    });
    // The schema allows only these ids; checked once more against this student's places.
    const place = places.find((p) => p.nodeId === answer.nodeId);
    deps.log(`[destinations] resolved: ${place ? "model" : "none"}`);
    if (!place) return result;
    return {
      kind: "resolved",
      destination: {
        nodeId: place.nodeId,
        path: place.path,
        page: { kind: "from_screen" },
        confidence: 0.6,
        method: "model",
      },
    };
  } catch {
    deps.log("[destinations] resolved: none (model unavailable)");
    return result;
  }
}
