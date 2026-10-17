import type { BBox, Stroke } from "@mew/shared";
import { type Camera, type Line, visibleRegion } from "@mew/ink";

import { paintDraft, paintStrokes } from "./paint";

export type Layers = { grid: HTMLCanvasElement; ink: HTMLCanvasElement; live: HTMLCanvasElement };

export type Theme = { dark: boolean; dot: string; tutor: string };

const GRID_SPACING = 24; // page units
const MIN_DOT_SPACING_PX = 12;

/**
 * Three stacked canvases: the dot grid, committed ink (redrawn only when the page or camera
 * changes), and a live layer for the stroke in progress and the eraser cursor. Keeping the
 * stroke being drawn on its own layer means a frame costs one outline, not the whole page.
 */
export class CanvasRenderer {
  private width = 0;
  private height = 0;
  private dpr = 1;
  private readonly grid: CanvasRenderingContext2D;
  private readonly ink: CanvasRenderingContext2D;
  private readonly live: CanvasRenderingContext2D;

  constructor(
    private readonly layers: Layers,
    private theme: Theme,
  ) {
    this.grid = context(layers.grid);
    this.ink = context(layers.ink);
    // Low-latency hint for the layer under the pen; the others favour tear-free compositing.
    this.live = context(layers.live, { desynchronized: true });
  }

  get cssSize(): { width: number; height: number } {
    return { width: this.width, height: this.height };
  }

  setTheme(theme: Theme): void {
    this.theme = theme;
  }

  resize(width: number, height: number, dpr: number): void {
    this.width = width;
    this.height = height;
    this.dpr = dpr;
    for (const canvas of Object.values(this.layers)) {
      canvas.width = Math.max(1, Math.round(width * dpr));
      canvas.height = Math.max(1, Math.round(height * dpr));
    }
  }

  /** Page region currently on screen. */
  visible(camera: Camera): BBox {
    return visibleRegion(camera, this.width, this.height);
  }

  drawGrid(camera: Camera): void {
    const ctx = this.grid;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);

    let spacing = GRID_SPACING;
    while (spacing * camera.zoom < MIN_DOT_SPACING_PX) spacing *= 2;
    const step = spacing * camera.zoom * this.dpr;
    const offsetX = -mod(camera.x, spacing) * camera.zoom * this.dpr;
    const offsetY = -mod(camera.y, spacing) * camera.zoom * this.dpr;
    const size = Math.max(1, 1.6 * this.dpr);

    ctx.fillStyle = this.theme.dot;
    for (let x = offsetX; x < ctx.canvas.width; x += step) {
      for (let y = offsetY; y < ctx.canvas.height; y += step) {
        ctx.fillRect(x - size / 2, y - size / 2, size, size);
      }
    }
  }

  /** Full redraw of committed ink. Pass only strokes in `visible(camera)` to cull off-screen work. */
  drawInk(camera: Camera, strokes: readonly Stroke[], lines?: readonly Line[]): void {
    const ctx = this.ink;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    this.applyCamera(ctx, camera);
    paintStrokes(ctx, strokes, this.theme.dark);
    if (lines) this.outlineLines(ctx, camera, lines);
  }

  drawLive(
    camera: Camera,
    draft: Stroke | null,
    eraser: { x: number; y: number; r: number } | null,
  ) {
    const ctx = this.live;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    this.applyCamera(ctx, camera);
    if (draft) paintDraft(ctx, draft, this.theme.dark);
    if (eraser) {
      ctx.beginPath();
      ctx.arc(eraser.x, eraser.y, eraser.r, 0, Math.PI * 2);
      ctx.lineWidth = 1 / camera.zoom;
      ctx.strokeStyle = this.theme.dot;
      ctx.stroke();
    }
  }

  private applyCamera(ctx: CanvasRenderingContext2D, camera: Camera): void {
    const scale = camera.zoom * this.dpr;
    ctx.setTransform(scale, 0, 0, scale, -camera.x * scale, -camera.y * scale);
  }

  /** Debug overlay: dashed boxes around segmented lines. */
  private outlineLines(ctx: CanvasRenderingContext2D, camera: Camera, lines: readonly Line[]) {
    ctx.save();
    ctx.lineWidth = 1 / camera.zoom;
    ctx.setLineDash([4 / camera.zoom, 3 / camera.zoom]);
    ctx.strokeStyle = this.theme.tutor;
    for (const { bbox } of lines)
      ctx.strokeRect(bbox[0] - 4, bbox[1] - 4, bbox[2] + 8, bbox[3] + 8);
    ctx.restore();
  }
}

function context(
  canvas: HTMLCanvasElement,
  options: CanvasRenderingContext2DSettings = {},
): CanvasRenderingContext2D {
  const ctx = canvas.getContext("2d", options);
  if (!ctx) throw new Error("Canvas 2D is not available");
  return ctx;
}

function mod(a: number, n: number): number {
  return ((a % n) + n) % n;
}
