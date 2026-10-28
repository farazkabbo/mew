import type { PreparedLine } from "./prepare";

/** An 8-bit grey image: 255 is white paper, 0 is ink. */
export type GreyImage = { width: number; height: number; pixels: Uint8Array };

/**
 * Draws a prepared line in black on white with round, even strokes and soft edges. Plain
 * TypeScript, so the browser and the eval (Node, no canvas) make the very same image.
 */
export function rasterize(line: PreparedLine): GreyImage {
  const { width, height } = line;
  const pixels = new Uint8Array(width * height).fill(255);
  const r = line.penWidth / 2;
  for (const poly of line.polylines) {
    if (poly.length === 2) {
      disc(pixels, width, height, poly[0] as number, poly[1] as number, r);
      continue;
    }
    for (let i = 0; i + 3 < poly.length; i += 2) {
      segment(
        pixels,
        width,
        height,
        poly[i] as number,
        poly[i + 1] as number,
        poly[i + 2] as number,
        poly[i + 3] as number,
        r,
      );
    }
  }
  return { width, height, pixels };
}

function disc(px: Uint8Array, w: number, h: number, x: number, y: number, r: number): void {
  segment(px, w, h, x, y, x, y, r);
}

function segment(
  px: Uint8Array,
  w: number,
  h: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  r: number,
): void {
  const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - r - 1));
  const x1 = Math.min(w - 1, Math.ceil(Math.max(ax, bx) + r + 1));
  const y0 = Math.max(0, Math.floor(Math.min(ay, by) - r - 1));
  const y1 = Math.min(h - 1, Math.ceil(Math.max(ay, by) + r + 1));
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  for (let y = y0; y <= y1; y++) {
    const py = y + 0.5;
    for (let x = x0; x <= x1; x++) {
      const pxc = x + 0.5;
      let t = len2 === 0 ? 0 : ((pxc - ax) * dx + (py - ay) * dy) / len2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const ex = ax + t * dx - pxc;
      const ey = ay + t * dy - py;
      const coverage = r + 0.5 - Math.sqrt(ex * ex + ey * ey);
      if (coverage <= 0) continue;
      const value = Math.round(255 * (1 - Math.min(1, coverage)));
      const i = y * w + x;
      if (value < (px[i] as number)) px[i] = value;
    }
  }
}
