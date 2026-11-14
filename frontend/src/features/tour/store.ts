import { create } from "zustand";

import { stepsFor } from "./steps";

/**
 * The guided tour's place (decision U32). It's kept in this device's storage, because the tour
 * runs across the app's real screens and must survive moving between them, and F5.
 */
type Saved = {
  /** The step being shown; null when no tour is running. */
  stepId: string | null;
  /** The notebook and page opened during the tour, so the guide can take the student back. */
  nodeId: string | null;
  pageId: string | null;
};

type TourState = Saved & {
  start(): void;
  /** On to the step after `fromId` (a late signal for an earlier step does nothing). */
  advance(fromId: string, desktop: boolean): void;
  /** "Skip this step" on a step the next ones depend on: straight to `toId`, from `fromId`. */
  skip(fromId: string, toId: string): void;
  back(desktop: boolean): void;
  end(): void;
  visited(made: Partial<Pick<Saved, "nodeId" | "pageId">>): void;
};

const KEY = "neb.tour";
const NONE: Saved = { stepId: null, nodeId: null, pageId: null };

function read(): Saved {
  try {
    const saved = JSON.parse(window.localStorage.getItem(KEY) ?? "null") as Partial<Saved> | null;
    if (!saved || typeof saved.stepId !== "string") return NONE;
    return {
      stepId: saved.stepId,
      nodeId: typeof saved.nodeId === "string" ? saved.nodeId : null,
      pageId: typeof saved.pageId === "string" ? saved.pageId : null,
    };
  } catch {
    return NONE; // storage blocked, or not a browser: no tour to resume
  }
}

function write({ stepId, nodeId, pageId }: Saved): void {
  try {
    if (stepId === null) window.localStorage.removeItem(KEY);
    else window.localStorage.setItem(KEY, JSON.stringify({ stepId, nodeId, pageId }));
  } catch {
    // the tour still runs, it just won't survive a reload
  }
}

export const useTour = create<TourState>((set, get) => {
  const save = (next: Partial<Saved>) => {
    set(next);
    const { stepId, nodeId, pageId } = get();
    write({ stepId, nodeId, pageId });
  };
  return {
    ...read(),
    start: () => save({ stepId: "welcome", nodeId: null, pageId: null }),
    advance: (fromId, desktop) => {
      if (get().stepId !== fromId) return;
      const steps = stepsFor(desktop);
      const next = steps[steps.findIndex((s) => s.id === fromId) + 1];
      save(next ? { stepId: next.id } : NONE);
    },
    skip: (fromId, toId) => {
      if (get().stepId === fromId) save({ stepId: toId });
    },
    back: (desktop) => {
      const steps = stepsFor(desktop);
      const previous = steps[steps.findIndex((s) => s.id === get().stepId) - 1];
      if (previous) save({ stepId: previous.id });
    },
    end: () => save(NONE),
    visited: (made) => {
      const { nodeId, pageId } = get();
      const next = { nodeId: made.nodeId ?? nodeId, pageId: made.pageId ?? pageId };
      if (next.nodeId !== nodeId || next.pageId !== pageId) save(next);
    },
  };
});

/** Starts the tour from its first step. */
export const startTour = () => useTour.getState().start();
