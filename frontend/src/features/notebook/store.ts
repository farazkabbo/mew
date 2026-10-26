import type { Stroke } from "@mew/shared";
import { create } from "zustand";

import { HIGHLIGHTER_COLORS, INK_COLORS, type PenSize, type Tool } from "./palette";

type ToolState = {
  tool: Tool;
  inkColor: string;
  highlighterColor: string;
  penSize: PenSize;
  /** Debug overlay showing how strokes were segmented into lines. */
  showLines: boolean;
  /** Whether the tutor's ink is drawn (hidden ink stays on the page, untouchable). */
  showTutorInk: boolean;
  /** Tutor ink groups hidden while an entry's explanation replays (Circle & Ask, S3.2 §5). */
  replayHidden: ReadonlySet<string>;
  /** Worked solutions folded into their "Solution · tap to peek" tab (K6 §6.1). */
  foldedGroups: ReadonlySet<string>;
  /**
   * A moment to bring into view once its page is open (K8: from Moments, Ctrl+K or a Quick
   * check), and replay with its voice when asked.
   */
  momentRequest: { imageId: string; replay: boolean } | null;
  /** K9: pages whose marks layer is hidden (the eye), remembered on this device. */
  marksHiddenOn: ReadonlySet<string>;
  /** K9: marks held back by "Hide marks until I'm done" (their stroke groups). */
  unrevealedMarks: ReadonlySet<string>;
  /** K9: a resolved mark's strokes, fading out on the live layer since `since`. */
  fadingMarks: { strokes: readonly Stroke[]; since: number } | null;
  /** Page Replay (K9): strokes not drawn again yet; null when no replay is running. */
  pageReplayHidden: ReadonlySet<string> | null;
};

type ViewState = {
  zoom: number;
  canUndo: boolean;
  canRedo: boolean;
  saveError: string | null;
};

type Actions = {
  setTool(tool: Tool): void;
  setColor(color: string): void;
  setPenSize(size: PenSize): void;
  toggleLines(): void;
  toggleTutorInk(): void;
  setReplayHidden(groups: ReadonlySet<string>): void;
  setFoldedGroups(groups: ReadonlySet<string>): void;
  requestMoment(request: { imageId: string; replay: boolean } | null): void;
  toggleMarksOn(pageId: string): void;
  setUnrevealedMarks(groups: ReadonlySet<string>): void;
  fadeMarks(strokes: readonly Stroke[]): void;
  setPageReplayHidden(ids: ReadonlySet<string> | null): void;
  setView(view: Partial<ViewState>): void;
};

const TUTOR_INK_KEY = "mew:show-tutor-ink";
const MARKS_HIDDEN_KEY = "mew:marks-hidden-pages";

/**
 * UI state for the notebook (tool choice, toolbar indicators). The canvas reads it with
 * `getState()` at gesture start, so changing tools never re-renders the canvas.
 */
export const useNotebookUi = create<ToolState & ViewState & Actions>()((set, get) => ({
  tool: "pen",
  inkColor: INK_COLORS[0].light,
  highlighterColor: HIGHLIGHTER_COLORS[0].light,
  penSize: "M",
  showLines: false,
  showTutorInk: readFlag(TUTOR_INK_KEY, true),
  replayHidden: new Set(),
  foldedGroups: new Set(),
  momentRequest: null,
  marksHiddenOn: new Set(readList(MARKS_HIDDEN_KEY)),
  unrevealedMarks: new Set(),
  fadingMarks: null,
  pageReplayHidden: null,
  zoom: 1,
  canUndo: false,
  canRedo: false,
  saveError: null,
  setTool: (tool) => set({ tool }),
  setColor: (color) =>
    set((state) =>
      state.tool === "highlighter" ? { highlighterColor: color } : { inkColor: color, tool: "pen" },
    ),
  setPenSize: (penSize) => set({ penSize }),
  toggleLines: () => set((state) => ({ showLines: !state.showLines })),
  toggleTutorInk: () => {
    const showTutorInk = !get().showTutorInk;
    writeFlag(TUTOR_INK_KEY, showTutorInk);
    set({ showTutorInk });
  },
  setReplayHidden: (replayHidden) => set({ replayHidden }),
  setFoldedGroups: (foldedGroups) => set({ foldedGroups }),
  requestMoment: (momentRequest) => set({ momentRequest }),
  toggleMarksOn: (pageId) => {
    const next = new Set(get().marksHiddenOn);
    if (!next.delete(pageId)) next.add(pageId);
    writeList(MARKS_HIDDEN_KEY, [...next].slice(-500));
    set({ marksHiddenOn: next });
  },
  setUnrevealedMarks: (unrevealedMarks) => set({ unrevealedMarks }),
  setPageReplayHidden: (pageReplayHidden) => set({ pageReplayHidden }),
  fadeMarks: (strokes) =>
    set({ fadingMarks: strokes.length > 0 ? { strokes, since: performance.now() } : null }),
  setView: (view) => set(view),
}));

function readFlag(key: string, fallback: boolean): boolean {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    return raw === null || raw === undefined ? fallback : raw === "1";
  } catch {
    return fallback;
  }
}

function writeFlag(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, value ? "1" : "0");
  } catch {
    // Storage unavailable: the setting lasts for this session only.
  }
}

function readList(key: string): string[] {
  if (typeof window === "undefined") return []; // the server render (and tests): nothing kept
  try {
    const raw = window.localStorage.getItem(key);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function writeList(key: string, values: readonly string[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(values));
  } catch {
    // Storage unavailable: the choice lasts for this session only.
  }
}
