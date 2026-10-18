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
  setView(view: Partial<ViewState>): void;
};

const TUTOR_INK_KEY = "mew:show-tutor-ink";

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
