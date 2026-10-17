/**
 * The microphone can pick up the tutor's own voice from the speakers (browser echo cancellation
 * doesn't always cover Web Audio playback). These helpers tell the student's words apart from an
 * echo of what the tutor is saying, by word overlap.
 */

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}'\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/** Words heard that the tutor didn't say. */
export function newWords(heard: string, spoken: string): number {
  const said = new Set(words(spoken));
  return words(heard).filter((w) => !said.has(w)).length;
}

/** Whether a transcript is most likely the tutor's own speech coming back through the mic. */
export function isLikelyEcho(heard: string, spoken: string): boolean {
  const heardWords = words(heard);
  if (heardWords.length === 0 || !spoken) return false;
  const said = new Set(words(spoken));
  const overlap = heardWords.filter((w) => said.has(w)).length / heardWords.length;
  return overlap >= 0.6;
}
