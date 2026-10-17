import { DEFAULT_MEW_THRESHOLD, type MewDecisionResponse, type MewTrigger } from "@mew/shared";
import { create } from "zustand";

export type DecisionRecord = MewDecisionResponse & {
  id: number;
  at: number;
  trigger: MewTrigger;
  utterance: string;
  /** Client-observed time from trigger to decision, including the network. */
  roundTripMs: number;
  /** Whether the decision passes the threshold (the tutor will respond from M3). */
  acted: boolean;
};

const MAX_RECORDS = 30;
const THRESHOLD_KEY = "mew:threshold";

type MewState = {
  decisions: DecisionRecord[];
  /** Gate evaluations in flight. */
  pending: number;
  threshold: number;
  debugOpen: boolean;
};

type MewActions = {
  begin(): void;
  record(record: Omit<DecisionRecord, "id">): void;
  setThreshold(threshold: number): void;
  toggleDebug(): void;
};

let nextId = 1;

export const useMew = create<MewState & MewActions>()((set) => ({
  decisions: [],
  pending: 0,
  threshold: readThreshold(),
  debugOpen: false,
  begin: () => set((s) => ({ pending: s.pending + 1 })),
  record: (record) =>
    set((s) => ({
      pending: Math.max(0, s.pending - 1),
      decisions: [{ ...record, id: nextId++ }, ...s.decisions].slice(0, MAX_RECORDS),
    })),
  setThreshold: (threshold) => {
    try {
      localStorage.setItem(THRESHOLD_KEY, String(threshold));
    } catch {
      // Storage may be unavailable (private mode); the setting just won't persist.
    }
    set({ threshold });
  },
  toggleDebug: () => set((s) => ({ debugOpen: !s.debugOpen })),
}));

function readThreshold(): number {
  try {
    const stored = Number(globalThis.localStorage?.getItem(THRESHOLD_KEY));
    return stored >= 0.3 && stored <= 0.95 ? stored : DEFAULT_MEW_THRESHOLD;
  } catch {
    return DEFAULT_MEW_THRESHOLD;
  }
}
