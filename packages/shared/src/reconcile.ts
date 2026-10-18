import type { LineCheck } from "./check";
import { type BoardAction, TUTOR_LIMITS } from "./tutor";

/** Short margin notes for errors the model didn't annotate itself. */
const DEFAULT_NOTES: Record<string, string> = {
  units: "check units",
  not_equal: "check arithmetic",
  unbalanced: "not balanced",
  error: "error here",
};

export function defaultNote(reason: string): string {
  return DEFAULT_NOTES[reason] ?? "check this step";
}

/**
 * Makes the board agree with the verifiers: never mark a verified-correct line wrong (or the
 * reverse), and make sure the line being checked gets its circle or tick even if the model left
 * it out. Language models don't get the last word on arithmetic.
 */
export function reconcileMarks(
  actions: readonly BoardAction[],
  checks: readonly LineCheck[],
): BoardAction[] {
  const verdict = new Map(checks.map((c) => [c.lineId, c.verdict]));
  const kept = actions.filter((action) => {
    if (action.type === "mark_error") return verdict.get(action.targetLineId) !== "correct";
    if (action.type === "mark_correct") return verdict.get(action.targetLineId) !== "incorrect";
    return true;
  });
  const marked = new Set(
    kept.flatMap((a) =>
      a.type === "mark_error" || a.type === "mark_correct" ? [a.targetLineId] : [],
    ),
  );
  const added: BoardAction[] = [];
  for (const check of checks) {
    if (!check.target || marked.has(check.lineId)) continue;
    if (check.verdict === "incorrect") {
      added.push({
        type: "mark_error",
        targetLineId: check.lineId,
        note: defaultNote(check.reason),
      });
    } else if (check.verdict === "correct") {
      added.push({ type: "mark_correct", targetLineId: check.lineId });
    }
  }
  // Marks first: they matter most when the action budget is tight.
  return [...added, ...kept].slice(0, TUTOR_LIMITS.actions);
}
