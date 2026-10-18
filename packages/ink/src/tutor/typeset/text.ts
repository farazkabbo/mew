import { type Box, EMPTY, glyphBox, hbox, space, vstack } from "./box";

/** Baseline-to-baseline distance between wrapped lines, in x-heights. */
export const LINE_LEADING = 2.6;
const WORD_SPACE = 0.75;

export type TextLayout = { box: Box; missing: string[] };

/**
 * Lays out plain text, wrapping at spaces to stay within `maxWidth` (x-heights). Characters the
 * font can't draw are skipped and reported in `missing`.
 */
export function typesetText(text: string, { maxWidth = Infinity, scale = 1 } = {}): TextLayout {
  const missing = new Set<string>();
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return { box: EMPTY, missing: [] };

  const wordBoxes = words.map((word) => {
    const glyphs: Box[] = [];
    for (const ch of word) {
      const box = glyphBox(ch, scale);
      if (box) glyphs.push(box);
      else missing.add(ch);
    }
    return hbox(glyphs);
  });

  const lines: Box[][] = [[]];
  let lineWidth = 0;
  for (const word of wordBoxes) {
    const current = lines.at(-1) ?? [];
    const added = current.length === 0 ? word.width : lineWidth + WORD_SPACE * scale + word.width;
    if (current.length > 0 && added > maxWidth) {
      lines.push([word]);
      lineWidth = word.width;
    } else {
      current.push(word);
      lineWidth = added;
    }
  }

  const rows = lines.map((row) =>
    hbox(row.flatMap((w, i) => (i === 0 ? [w] : [space(WORD_SPACE * scale), w]))),
  );
  return { box: vstack(rows, LINE_LEADING * scale), missing: [...missing] };
}
