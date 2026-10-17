import { create } from "zustand";

import { HIGHLIGHTER_COLORS, INK_COLORS, type PenSize, type Tool } from "./palette";

type ToolState = {
  tool: Tool;
  inkColor: string;
  highlighterColor: string;
  penSize: PenSize;
  /** Debug overlay showing how strokes were segmented into lines. */
  showLines: boolean;
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
  setView(view: Partial<ViewState>): void;
};

/**
 * UI state for the notebook (tool choice, toolbar indicators). The canvas reads it with
 * `getState()` at gesture start, so changing tools never re-renders the canvas.
 */
export const useNotebookUi = create<ToolState & ViewState & Actions>()((set) => ({
  tool: "pen",
  inkColor: INK_COLORS[0].light,
  highlighterColor: HIGHLIGHTER_COLORS[0].light,
  penSize: "M",
  showLines: false,
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
  setView: (view) => set(view),
}));
