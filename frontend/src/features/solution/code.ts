import type { BBox } from "@mew/shared";

/** Spaces per indentation level in a program rebuilt from handwriting. */
const INDENT = "    ";

/**
 * A program written by hand, line by line (a code Your Turn, K6 §6.1). Recognition reads each
 * line's text but not its indentation, so the indentation comes from where each line starts:
 * starts within half a line's height of each other are one level, and each level further right
 * is four more spaces. Typographic quotes, which handwriting often comes back as, are made plain.
 */
export function programFrom(lines: readonly { text: string; bbox: BBox }[]): string {
  const heights = lines.map((l) => l.bbox[3]).sort((a, b) => a - b);
  const tolerance = (heights[Math.floor(heights.length / 2)] ?? 0) / 2;
  const levels: number[] = [];
  for (const x of lines.map((l) => l.bbox[0]).sort((a, b) => a - b)) {
    const last = levels.at(-1);
    if (last === undefined || x - last > tolerance) levels.push(x);
  }
  return lines
    .map(({ text, bbox }) => {
      const level = Math.max(
        0,
        levels.findLastIndex((start) => start <= bbox[0]),
      );
      return INDENT.repeat(level) + plainQuotes(text.trim());
    })
    .join("\n");
}

function plainQuotes(text: string): string {
  return text.replace(/[“”„]/g, '"').replace(/[‘’‚]/g, "'");
}

/** The program printed what the answer key says (line by line, trailing spaces aside). */
export function sameOutput(printed: string, expected: string): boolean {
  const lines = (text: string) =>
    text
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .map((line) => line.trimEnd())
      .join("\n")
      .trim();
  return lines(printed) === lines(expected);
}
