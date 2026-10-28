import { DEFAULT_MARK_LEVEL, MarkLevel } from "@mew/shared";
import { z } from "zod";
import { create } from "zustand";

/**
 * How much the tutor marks, per notebook (K9 §7.1: a toolbar toggle "saved per notebook"), and
 * "Hide marks until I'm done". Kept on this device. When the day's budget for live marking runs
 * out (§7.5), every notebook drops to Quiet until the next day, with a notice.
 */
const Prefs = z.object({
  level: MarkLevel,
  hideUntilDone: z.boolean(),
});
type Prefs = z.infer<typeof Prefs>;

const KEY = "mew:mark-prefs";
/** This device's level for notebooks without one of their own (onboarding asks, §5.10). */
const DEFAULT_KEY = "neb:mark-default";
const FALLBACK: Readonly<Record<MarkLevel, Prefs>> = {
  off: { level: "off", hideUntilDone: false },
  quiet: { level: "quiet", hideUntilDone: false },
  normal: { level: "normal", hideUntilDone: false },
  coach: { level: "coach", hideUntilDone: false },
};

type MarkPrefsState = {
  byNotebook: Readonly<Record<string, Prefs>>;
  /** The level a notebook starts with (Hint unless the student chose another). */
  defaultLevel: MarkLevel;
  /** Until when the budget is spent (0: it isn't). */
  quietUntil: number;
  prefsFor(notebookId: string | null): Prefs;
  /** The level in force: the notebook's, or Quiet while the budget is spent. */
  levelFor(notebookId: string | null, now?: number): MarkLevel;
  setLevel(notebookId: string, level: MarkLevel): void;
  setDefaultLevel(level: MarkLevel): void;
  setHideUntilDone(notebookId: string, hide: boolean): void;
  /** The budget ran out: Quiet until the end of the day. Returns false if it already was. */
  budgetSpent(now?: number): boolean;
};

const QUIETER: Record<MarkLevel, MarkLevel> = {
  off: "off",
  quiet: "quiet",
  normal: "quiet",
  coach: "quiet",
};

export const useMarkPrefs = create<MarkPrefsState>()((set, get) => ({
  byNotebook: read(),
  defaultLevel: readDefault(),
  quietUntil: 0,
  prefsFor: (id) => {
    // One object per level: selectors compare by identity, so a new one each call would loop.
    const fallback = FALLBACK[get().defaultLevel];
    return id ? (get().byNotebook[id] ?? fallback) : fallback;
  },
  levelFor: (id, now = Date.now()) => {
    const level = get().prefsFor(id).level;
    return now < get().quietUntil ? QUIETER[level] : level;
  },
  setLevel: (id, level) => update(set, get, id, { level }),
  setDefaultLevel: (level) => {
    set({ defaultLevel: level });
    try {
      localStorage.setItem(DEFAULT_KEY, level);
    } catch {
      // Storage unavailable: the choice lasts for this session only.
    }
  },
  setHideUntilDone: (id, hideUntilDone) => update(set, get, id, { hideUntilDone }),
  budgetSpent: (now = Date.now()) => {
    if (now < get().quietUntil) return false;
    const end = new Date(now);
    end.setHours(24, 0, 0, 0);
    set({ quietUntil: end.getTime() });
    return true;
  },
}));

function update(
  set: (partial: Partial<MarkPrefsState>) => void,
  get: () => MarkPrefsState,
  id: string,
  change: Partial<Prefs>,
) {
  const byNotebook = { ...get().byNotebook, [id]: { ...get().prefsFor(id), ...change } };
  set({ byNotebook });
  try {
    localStorage.setItem(KEY, JSON.stringify(byNotebook));
  } catch {
    // Storage unavailable: the choice lasts for this session only.
  }
}

function readDefault(): MarkLevel {
  if (typeof window === "undefined") return DEFAULT_MARK_LEVEL;
  try {
    const parsed = MarkLevel.safeParse(window.localStorage.getItem(DEFAULT_KEY));
    return parsed.success ? parsed.data : DEFAULT_MARK_LEVEL;
  } catch {
    return DEFAULT_MARK_LEVEL;
  }
}

function read(): Record<string, Prefs> {
  if (typeof window === "undefined") return {}; // the server render (and tests): nothing kept
  try {
    const raw = window.localStorage.getItem(KEY);
    const parsed = z.record(z.string(), Prefs).safeParse(raw ? JSON.parse(raw) : {});
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}
