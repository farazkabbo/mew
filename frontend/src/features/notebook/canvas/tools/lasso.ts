import type { BBox, Stroke } from "@mew/shared";
import { bboxContainsPoint, inflateBBox, unionBBox, type Vec } from "@mew/ink";

import { isEditable } from "../../visibility";
import type { PagePoint, ToolContext, ToolController } from "./types";

/** Lasso points closer than this (CSS px) are skipped. */
const MIN_LASSO_STEP_PX = 3;
/** Grab margin around the selection box (CSS px). */
const GRAB_MARGIN_PX = 8;

/**
 * Lasso select: draw a loop to select strokes, drag inside the selection to move them,
 * Delete/Backspace to remove them, Escape to deselect.
 */
export class LassoTool implements ToolController {
  private mode: "idle" | "drawing" | "dragging" = "idle";
  private dragOrigin: Vec = [0, 0];

  constructor(private readonly ctx: ToolContext) {}

  begin(point: PagePoint): void {
    const { selection } = this.ctx.overlay;
    const grab = GRAB_MARGIN_PX / this.ctx.zoom();
    if (selection && bboxContainsPoint(inflateBBox(selection.bbox, grab), point.x, point.y)) {
      this.mode = "dragging";
      this.dragOrigin = [point.x, point.y];
      return;
    }
    this.mode = "drawing";
    this.setSelection(null);
    this.ctx.overlay.lasso = [[point.x, point.y]];
    this.ctx.invalidate({ ink: true, live: true });
  }

  move(points: readonly PagePoint[]): void {
    const { overlay } = this.ctx;
    const last = points.at(-1);
    if (!last) return;

    if (this.mode === "dragging" && overlay.selection) {
      overlay.selection.dx = last.x - this.dragOrigin[0];
      overlay.selection.dy = last.y - this.dragOrigin[1];
    } else if (this.mode === "drawing" && overlay.lasso) {
      const step = MIN_LASSO_STEP_PX / this.ctx.zoom();
      for (const p of points) {
        const prev = overlay.lasso.at(-1);
        if (!prev || Math.hypot(p.x - prev[0], p.y - prev[1]) >= step)
          overlay.lasso.push([p.x, p.y]);
      }
    }
    this.ctx.invalidate({ live: true });
  }

  end(): void {
    const { overlay, engine } = this.ctx;
    if (this.mode === "drawing" && overlay.lasso) {
      this.setSelection(engine.doc.inLasso(overlay.lasso).filter(isEditable));
      overlay.lasso = null;
    } else if (this.mode === "dragging" && overlay.selection) {
      const { strokes, dx, dy } = overlay.selection;
      const ids = strokes.map((s) => s.id);
      engine.moveStrokes(ids, dx, dy);
      this.setSelection(ids.map((id) => engine.doc.get(id)).filter((s) => s !== undefined));
    }
    this.mode = "idle";
    this.ctx.invalidate({ ink: true, live: true });
  }

  cancel(): void {
    const { overlay } = this.ctx;
    overlay.lasso = null;
    if (overlay.selection) overlay.selection.dx = overlay.selection.dy = 0;
    this.mode = "idle";
    this.ctx.invalidate({ live: true });
  }

  key(event: KeyboardEvent): boolean {
    const { selection } = this.ctx.overlay;
    if (!selection) return false;
    if (event.key === "Delete" || event.key === "Backspace") {
      this.ctx.engine.deleteStrokes(selection.strokes.map((s) => s.id));
      this.setSelection(null);
      return true;
    }
    if (event.key === "Escape") {
      this.setSelection(null);
      return true;
    }
    return false;
  }

  deactivate(): void {
    this.cancel();
    this.setSelection(null);
  }

  /** Drops selected strokes that no longer exist and picks up their current versions. */
  documentChanged(): void {
    const { selection } = this.ctx.overlay;
    if (!selection || this.mode === "dragging") return;
    const current = selection.strokes
      .map((s) => this.ctx.engine.doc.get(s.id))
      .filter((s) => s !== undefined);
    this.setSelection(current);
  }

  private setSelection(strokes: Stroke[] | null): void {
    const bbox = strokes?.length ? strokes.map((s) => s.bbox).reduce(unionBBox) : null;
    this.ctx.overlay.selection =
      strokes && bbox ? { strokes, bbox: bbox as BBox, dx: 0, dy: 0 } : null;
    this.ctx.invalidate({ ink: true, live: true });
    if (this.mode !== "dragging") this.ctx.selected?.(this.ctx.overlay.selection ? strokes : null);
  }
}
