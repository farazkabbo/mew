import type { AnswerStyle, BoardAction, LineCheck, TutorRequest } from "@mew/shared";
import { create } from "zustand";

export type TutorPhase = "idle" | "thinking" | "speaking";

/** Milliseconds from the trigger (end of utterance, tap, pause) to each stage of a turn. */
export type TurnTimings = {
  gateMs?: number;
  tutorSpeechMs?: number;
  firstAudioMs?: number;
  inkStartMs?: number;
  totalMs?: number;
};

export type Turn = {
  id: number;
  at: number;
  intent: TutorRequest["intent"];
  utterance: string;
  speech: string | null;
  /** Board actions from the response, and what the ink renderer made of them. */
  actions: BoardAction[];
  /** Verified verdicts the turn was based on (check_work). */
  checks?: LineCheck[];
  ink?: {
    strokes: number;
    skipped: { index: number; type: string; reason: string }[];
    missing: string[];
  };
  timings: TurnTimings;
  outcome: "pending" | "done" | "interrupted" | "failed";
};

const MAX_TURNS = 20;
const SETTINGS_KEY = "mew:tutor-settings";

/** `autoCheck`: check each finished line quietly after a writing pause (tick or circle). */
type Settings = { answerStyle: AnswerStyle; captions: boolean; autoCheck: boolean };

type TutorState = Settings & {
  phase: TutorPhase;
  /** Text of what the tutor is saying (or last said), for the caption bubble. */
  caption: string | null;
  turns: Turn[];
  lastFinishedAt: number | null;
};

type TutorActions = {
  begin(turn: Pick<Turn, "intent" | "utterance" | "at"> & { gateMs: number }): number;
  update(id: number, patch: Partial<Omit<Turn, "timings">>, timings?: TurnTimings): void;
  setPhase(phase: TutorPhase): void;
  setCaption(caption: string | null): void;
  /** Records the outcome; `settle` returns the tutor to idle (false when a newer turn runs). */
  finish(id: number, outcome: Turn["outcome"], settle?: boolean): void;
  setSettings(settings: Partial<Settings>): void;
};

let nextId = 1;

export const useTutor = create<TutorState & TutorActions>()((set, get) => ({
  ...readSettings(),
  phase: "idle",
  caption: null,
  turns: [],
  lastFinishedAt: null,
  begin: ({ intent, utterance, at, gateMs }) => {
    const id = nextId++;
    const turn: Turn = {
      id,
      at,
      intent,
      utterance,
      speech: null,
      actions: [],
      timings: { gateMs },
      outcome: "pending",
    };
    set({ phase: "thinking", turns: [turn, ...get().turns].slice(0, MAX_TURNS) });
    return id;
  },
  update: (id, patch, timings) =>
    set({
      turns: get().turns.map((t) =>
        t.id === id ? { ...t, ...patch, timings: { ...t.timings, ...timings } } : t,
      ),
    }),
  setPhase: (phase) => set({ phase }),
  setCaption: (caption) => set({ caption }),
  finish: (id, outcome, settle = true) => {
    const turn = get().turns.find((t) => t.id === id);
    get().update(id, { outcome }, turn ? { totalMs: Date.now() - turn.at } : undefined);
    if (settle) set({ phase: "idle", lastFinishedAt: Date.now() });
  },
  setSettings: (patch) => {
    const settings = {
      answerStyle: get().answerStyle,
      captions: get().captions,
      autoCheck: get().autoCheck,
      ...patch,
    };
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {
      // Storage unavailable: settings last for this session only.
    }
    set(settings);
  },
}));

function readSettings(): Settings {
  const fallback: Settings = { answerStyle: "hints_first", captions: true, autoCheck: true };
  try {
    const raw = globalThis.localStorage?.getItem(SETTINGS_KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<Settings>) : {};
    return {
      answerStyle: parsed.answerStyle === "direct" ? "direct" : fallback.answerStyle,
      captions: typeof parsed.captions === "boolean" ? parsed.captions : fallback.captions,
      autoCheck: typeof parsed.autoCheck === "boolean" ? parsed.autoCheck : fallback.autoCheck,
    };
  } catch {
    return fallback;
  }
}
