import { strokeBBox } from "@mew/ink";
import { MAX_POINTS_PER_STROKE, type Point } from "@mew/shared";

import { HIGHLIGHTER_WIDTH, PEN_WIDTHS } from "../../palette";
import { useNotebookUi } from "../../store";
import type { PagePoint, ToolContext, ToolController } from "./types";

/** Ignore samples closer than this to the previous one (CSS px) to keep strokes compact. */
const MIN_SAMPLE_DISTANCE_PX = 0.75;

/** Pen and highlighter: builds a draft stroke and commits it on release. */
export class PenTool implements ToolController {
  private startTime = 0;

  constructor(private readonly ctx: ToolContext) {}

  begin(point: PagePoint): void {
    const { tool, inkColor, highlighterColor, penSize } = useNotebookUi.getState();
    const highlighter = tool === "highlighter";
    const width = highlighter ? HIGHLIGHTER_WIDTH : PEN_WIDTHS[penSize];
    const points: Point[] = [[round(point.x), round(point.y), point.pressure, 0]];
    this.startTime = point.time;
    this.ctx.overlay.draft = {
      id: crypto.randomUUID(),
      pageId: this.ctx.engine.pageId,
      author: "student",
      tool: highlighter ? "highlighter" : "pen",
      points,
      color: highlighter ? highlighterColor : inkColor,
      width,
      bbox: strokeBBox(points, width),
      createdAt: Date.now(),
    };
    this.ctx.invalidate({ live: true });
  }

  move(points: readonly PagePoint[]): void {
    const draft = this.ctx.overlay.draft;
    if (!draft) return;
    const minDistance = MIN_SAMPLE_DISTANCE_PX / this.ctx.zoom();
    for (const p of points) {
      const last = draft.points.at(-1);
      if (last && Math.hypot(p.x - last[0], p.y - last[1]) < minDistance) continue;
      if (draft.points.length >= MAX_POINTS_PER_STROKE) break;
      draft.points.push([round(p.x), round(p.y), p.pressure, Math.round(p.time - this.startTime)]);
    }
    this.ctx.invalidate({ live: true });
  }

  end(): void {
    const draft = this.ctx.overlay.draft;
    if (draft) {
      const points = [...draft.points];
      this.ctx.engine.addStroke({ ...draft, points, bbox: strokeBBox(points, draft.width) });
    }
    this.cancel();
  }

  cancel(): void {
    this.ctx.overlay.draft = null;
    this.ctx.invalidate({ live: true });
  }
}

/** Two decimals of a page unit is far below visible precision and keeps storage small. */
function round(value: number): number {
  return Math.round(value * 100) / 100;
}
