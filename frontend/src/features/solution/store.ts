import { create } from "zustand";

import type { LocalSolution } from "./record";

export type ShowThenYouPhase = "idle" | "solving" | "showing" | "your_turn" | "done";

type State = {
  phase: ShowThenYouPhase;
  /** The open page's worked solutions (their tabs) and Your Turns. */
  solutions: LocalSolution[];
  /** Solutions open for a peek (by id). */
  peeking: ReadonlySet<string>;
  /** Two misses on one line: the Your Turn offers a hint step. */
  offerHint: boolean;
  /** "You got it on your own." / "You got it." once the Your Turn is done. */
  finished: string | null;
};

type Actions = {
  set(state: Partial<State>): void;
  upsert(record: LocalSolution): void;
};

/** Show-then-You's UI state (K6); the flow owns the logic. */
export const useShowThenYou = create<State & Actions>()((set) => ({
  phase: "idle",
  solutions: [],
  peeking: new Set(),
  offerHint: false,
  finished: null,
  set: (state) => set(state),
  upsert: (record) =>
    set((state) => ({
      solutions: [...state.solutions.filter((s) => s.id !== record.id), record].sort(
        (a, b) => a.createdAt - b.createdAt,
      ),
    })),
}));
