import type { Stroke } from "@mew/shared";

/** 32-bit FNV-1a, hex encoded. Fast and stable; used as a cache key, not for security. */
export function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * What a line says, as far as its strokes go: their ids and point counts, in any order. Strokes
 * are immutable apart from being moved, so this changes when one is written, erased or undone,
 * but not when the line is moved (its text is the same). Notes Check re-recognises a line when
 * this changes (docs/SCREEN_COACH_NOTES_CHECK.md, decision 5).
 */
export function lineContentHash(strokes: readonly Pick<Stroke, "id" | "points">[]): string {
  return fnv1a(
    strokes
      .map((s) => `${s.id}:${s.points.length}`)
      .sort()
      .join("|"),
  );
}

/**
 * Cache key for a group of strokes (e.g. a line sent for recognition). Order-independent; changes
 * when any stroke is added, removed or moved.
 */
export function strokeGroupHash(strokes: readonly Pick<Stroke, "id" | "bbox">[]): string {
  const parts = strokes.map((s) => `${s.id}@${s.bbox.map((v) => v.toFixed(1)).join(",")}`).sort();
  return fnv1a(parts.join("|"));
}
