/** A line as it was last seen: the id it was given and the strokes it had then. */
export type KnownLine = { id: string; strokeIds: readonly string[] };

/** A line as segmentation sees it now (only what matching needs). */
export type SegmentedLine = { strokeIds: readonly string[]; firstCreatedAt: number };

export type IdentifiedLines<L> = {
  /** Every current line with its lasting id, in the order given. */
  lines: { line: L; id: string }[];
  /** Ids of earlier lines that no current line continues. */
  removed: string[];
};

/**
 * Gives each line from a new segmentation the id it had before, so whatever refers to a line
 * (its server copy, marks on it) follows it while it's extended, corrected or re-segmented.
 *
 * A line keeps an earlier line's id when it still holds at least half of that line's strokes.
 * Each earlier id goes to one line at most: the one sharing the most strokes with it (on a tie,
 * the line written first). Lines that continue no earlier line get a new id. So a line split in
 * two keeps its id on the larger part, and two lines merged into one keep one of their ids.
 */
export function assignLineIds<L extends SegmentedLine>(
  known: readonly KnownLine[],
  lines: readonly L[],
  newId: () => string,
): IdentifiedLines<L> {
  const ownerOf = new Map<string, number>();
  known.forEach((k, index) => {
    for (const stroke of k.strokeIds) ownerOf.set(stroke, index);
  });

  type Candidate = { line: number; known: number; shared: number };
  const candidates: Candidate[] = [];
  lines.forEach((line, lineIndex) => {
    const shared = new Map<number, number>();
    for (const stroke of line.strokeIds) {
      const owner = ownerOf.get(stroke);
      if (owner !== undefined) shared.set(owner, (shared.get(owner) ?? 0) + 1);
    }
    for (const [knownIndex, count] of shared) {
      const before = known[knownIndex]?.strokeIds.length ?? 0;
      if (count * 2 >= before)
        candidates.push({ line: lineIndex, known: knownIndex, shared: count });
    }
  });
  candidates.sort(
    (a, b) =>
      b.shared - a.shared ||
      (lines[a.line]?.firstCreatedAt ?? 0) - (lines[b.line]?.firstCreatedAt ?? 0) ||
      a.line - b.line ||
      a.known - b.known,
  );

  const idOfLine = new Map<number, string>();
  const used = new Set<number>();
  for (const { line, known: knownIndex } of candidates) {
    const id = known[knownIndex]?.id;
    if (idOfLine.has(line) || used.has(knownIndex) || id === undefined) continue;
    idOfLine.set(line, id);
    used.add(knownIndex);
  }

  return {
    lines: lines.map((line, index) => ({ line, id: idOfLine.get(index) ?? newId() })),
    removed: known.filter((_, index) => !used.has(index)).map((k) => k.id),
  };
}
