/**
 * Fuzzy matching for the jump palette (Ctrl+K): every query character must appear in order;
 * matches at word starts and in runs score higher, and shorter texts win ties. 0 is no match.
 */
export function fuzzyScore(query: string, text: string): number {
  const q = normalise(query);
  const t = normalise(text);
  if (q.length === 0) return 1;
  let score = 0;
  let at = 0;
  let previous = -2;
  for (const char of q) {
    if (char === " ") continue;
    const found = t.indexOf(char, at);
    if (found < 0) return 0;
    const wordStart = found === 0 || /[\s›·.\-_/]/.test(t[found - 1] ?? "");
    score += 1 + (wordStart ? 2 : 0) + (found === previous + 1 ? 1.5 : 0);
    previous = found;
    at = found + 1;
  }
  // The whole query as one run (a typed word) is the strongest signal of all.
  if (t.includes(q)) score += q.length;
  return score / (1 + t.length / 200);
}

/**
 * Where the query matched in `text` (character indexes), for underlining them: the typed word as
 * one run when it's there, otherwise each character in order, as `fuzzyScore` finds them.
 */
export function fuzzyMatches(query: string, text: string): number[] {
  const q = normalise(query).replace(/\s+/g, "");
  const t = normalise(text);
  if (!q || t.length !== text.length) return [];
  const run = t.indexOf(q);
  if (run >= 0) return Array.from({ length: q.length }, (_, i) => run + i);
  const found: number[] = [];
  let at = 0;
  for (const char of q) {
    const index = t.indexOf(char, at);
    if (index < 0) return [];
    found.push(index);
    at = index + 1;
  }
  return found;
}

function normalise(text: string): string {
  return text.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
}
