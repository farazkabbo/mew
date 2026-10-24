/**
 * What the progress pill shows (coach mode, S4), as Rust sends it (`walkthrough::PillView`).
 * Checked by hand rather than with zod: zod would make the pill's page 400 KB.
 */
const STATES = ["awaiting", "confirming", "paused", "busy", "finished"] as const;
export type PillState = (typeof STATES)[number];
export type PillView = { title: string; progress: string; state: PillState; summary?: string };

/** The view if `detail` is one; null for anything else. */
export function parsePillView(detail: unknown): PillView | null {
  if (typeof detail !== "object" || detail === null) return null;
  const { title, progress, state, summary } = detail as Record<string, unknown>;
  const text = (value: unknown, max: number): value is string =>
    typeof value === "string" && value.length <= max;
  const known = (value: unknown): value is PillState =>
    typeof value === "string" && (STATES as readonly string[]).includes(value);
  if (!text(title, 60) || !text(progress, 40) || !known(state)) return null;
  if (summary !== undefined && !text(summary, 300)) return null;
  return { title, progress, state, ...(summary !== undefined && { summary }) };
}
