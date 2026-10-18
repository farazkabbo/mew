import type { Line } from "@mew/ink";

/** Most lines of working sent for one check (the API accepts up to 8). */
export const MAX_STEPS = 4;

/**
 * The lines of working that lead to `target`: lines above it in the same column, closest first,
 * stopping at a big vertical gap (a new problem). Returned top to bottom, ending with `target`.
 */
export function derivationLines(lines: readonly Line[], target: Line): Line[] {
  const [tx, , tw, th] = target.bbox;
  const above = lines
    .filter((l) => l.id !== target.id && l.bbox[1] + l.bbox[3] / 2 < target.bbox[1] + th / 2)
    .filter((l) => overlap(l.bbox[0], l.bbox[0] + l.bbox[2], tx, tx + tw) > 0)
    .sort((a, b) => b.bbox[1] - a.bbox[1]);

  const chain: Line[] = [target];
  let top = target.bbox[1];
  for (const line of above) {
    if (chain.length >= MAX_STEPS) break;
    const gap = top - (line.bbox[1] + line.bbox[3]);
    if (gap > 2.5 * Math.max(th, line.bbox[3])) break;
    chain.unshift(line);
    top = line.bbox[1];
  }
  return chain;
}

function overlap(a0: number, a1: number, b0: number, b1: number): number {
  return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
}
