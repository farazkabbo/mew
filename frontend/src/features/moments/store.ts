import {
  examSoon,
  type MomentCheckView,
  type MomentStayed,
  type SavedQuizFilter,
} from "@mew/shared";
import { create } from "zustand";

import { coursesApi } from "../courses/api";
import { momentsApi } from "./api";

/** Read again at most this often (on focus, on opening a home); an answer updates it at once. */
const FRESH_MS = 60_000;

type MomentChecksState = {
  /** Every active check (no keys), or null before the first read (or signed out, offline). */
  checks: MomentCheckView[] | null;
  loadedAt: number;
  /** A course's exam within two weeks: its reviews come first, the Quick check stays short. */
  exam: ReturnType<typeof examSoon>;
  /** What stayed per notebook (§6.4), or null before it's read (or if it can't be). */
  stayed: MomentStayed["notebooks"] | null;
  /** The Quick check being taken, with what it was asked for ("…saved today"). */
  quickCheck: { filter: SavedQuizFilter | null; nodeIds: readonly string[] | null } | null;
  load(force?: boolean): Promise<void>;
  /** An answered check comes back later: its new due time (or it's gone, when cleared). */
  answered(id: string, nextDue: string): void;
  clear(): void;
  openQuickCheck(options?: {
    filter?: SavedQuizFilter | null;
    nodeIds?: readonly string[] | null;
  }): void;
  closeQuickCheck(): void;
  /** What the student said while a Quick check is open: its answer, not words for Mew. */
  heard: { text: string; at: number } | null;
  hear(text: string): void;
};

/** A saved moment's checks (K8 §4.7), shared by the badges, the Quick check and Review. */
export const useMomentChecks = create<MomentChecksState>()((set, get) => ({
  checks: null,
  loadedAt: 0,
  exam: null,
  stayed: null,
  quickCheck: null,
  load: async (force = false) => {
    if (!force && Date.now() - get().loadedAt < FRESH_MS) return;
    set({ loadedAt: Date.now() });
    try {
      const [{ checks }, courses, stayed] = await Promise.all([
        momentsApi.checks(),
        coursesApi.list().catch(() => []),
        momentsApi.stayed().catch(() => null),
      ]);
      set({ checks, exam: examSoon(courses, Date.now()), stayed: stayed?.notebooks ?? null });
    } catch {
      // Offline or signed out: the badges just don't show; nothing else depends on them.
      set({ loadedAt: 0 });
    }
  },
  answered: (id, nextDue) =>
    set((state) => ({
      checks:
        state.checks?.map((c) => (c.id === id ? { ...c, dueAt: nextDue, isNew: false } : c)) ??
        null,
    })),
  clear: () => set({ checks: [] }),
  openQuickCheck: ({ filter = null, nodeIds = null } = {}) =>
    set({ quickCheck: { filter, nodeIds } }),
  closeQuickCheck: () => set({ quickCheck: null, heard: null }),
  heard: null,
  hear: (text) => set({ heard: { text, at: Date.now() } }),
}));
