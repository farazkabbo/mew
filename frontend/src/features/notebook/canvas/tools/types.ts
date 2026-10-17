import type { BBox, Stroke } from "@mew/shared";
import type { Vec } from "@mew/ink";

import type { PageEngine } from "../../engine";

/** A pointer sample converted to page coordinates. */
export type PagePoint = { x: number; y: number; pressure: number; time: number };

/** Transient things drawn on the live layer above committed ink. */
export type Overlay = {
  /** Stroke being drawn. */
  draft: Stroke | null;
  eraser: { x: number; y: number; r: number } | null;
  /** Lasso path being drawn. */
  lasso: Vec[] | null;
  /** Selected strokes, drawn on the live layer offset by (dx, dy) while being dragged. */
  selection: { strokes: Stroke[]; bbox: BBox; dx: number; dy: number } | null;
};

export type ToolContext = {
  engine: PageEngine;
  overlay: Overlay;
  /** Current zoom, for converting screen-pixel sizes to page units. */
  zoom(): number;
  invalidate(layers: { ink?: boolean; live?: boolean }): void;
};

/** One drawing tool's handling of a pointer gesture. */
export interface ToolController {
  begin(point: PagePoint): void;
  move(points: readonly PagePoint[]): void;
  end(): void;
  cancel(): void;
  hover?(point: PagePoint | null): void;
  /** Handles a key press; returns true if it was consumed. */
  key?(event: KeyboardEvent): boolean;
  /** Called when the user switches to another tool. */
  deactivate?(): void;
  /** Called after the document changed outside this tool (undo, another tab). */
  documentChanged?(): void;
}
