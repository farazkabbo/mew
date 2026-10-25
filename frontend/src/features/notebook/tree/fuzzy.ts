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

function normalise(text: string): string {
  return text.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
}
