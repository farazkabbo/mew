import { ERASER_RADIUS_PX } from "../../palette";
import { isEditable } from "../../visibility";
import type { PagePoint, ToolContext, ToolController } from "./types";

/** Stroke eraser: removes whole strokes it touches; one drag is one undo step. */
export class EraserTool implements ToolController {
  private last: [number, number] | null = null;

  constructor(private readonly ctx: ToolContext) {}

  begin(point: PagePoint): void {
    this.last = [point.x, point.y];
    this.eraseTo(point);
  }

  move(points: readonly PagePoint[]): void {
    for (const point of points) this.eraseTo(point);
  }

  end(): void {
    this.last = null;
    this.ctx.engine.endErase();
  }

  cancel(): void {
    this.end();
  }

  hover(point: PagePoint | null): void {
    this.ctx.overlay.eraser = point ? { x: point.x, y: point.y, r: this.radius() } : null;
    this.ctx.invalidate({ live: true });
  }

  deactivate(): void {
    this.hover(null);
  }

  private eraseTo(point: PagePoint): void {
    const from = this.last ?? [point.x, point.y];
    const to: [number, number] = [point.x, point.y];
    if (this.ctx.engine.eraseAlong(from, to, this.radius(), isEditable)) {
      this.ctx.invalidate({ ink: true });
    }
    this.last = to;
    this.hover(point);
  }

  private radius(): number {
    return ERASER_RADIUS_PX / this.ctx.zoom();
  }
}
