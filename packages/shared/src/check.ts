import { z } from "zod";

export const CHECK_LIMITS = { steps: 8, stepChars: 300, checksPerTurn: 8 } as const;

export const Verdict = z.enum(["correct", "incorrect", "unknown"]);
export type Verdict = z.infer<typeof Verdict>;

// ─── Maths (SymPy on the API service) ──────────────────────────────────────────────────────

export const MathCheckRequest = z.object({
  /** Consecutive lines of working as LaTeX, top to bottom. */
  steps: z.array(z.string().min(1).max(CHECK_LIMITS.stepChars)).min(1).max(CHECK_LIMITS.steps),
});
export type MathCheckRequest = z.infer<typeof MathCheckRequest>;

export const StepResult = z.object({
  index: z.number().int().nonnegative(),
  verdict: Verdict,
  reason: z.string().max(40),
  detail: z.string().max(300).nullish(),
});
export type StepResult = z.infer<typeof StepResult>;

export const MathCheckResponse = z.object({ results: z.array(StepResult).max(CHECK_LIMITS.steps) });
export type MathCheckResponse = z.infer<typeof MathCheckResponse>;

// ─── What the tutor is told ─────────────────────────────────────────────────────────────────

export const Checker = z.enum(["math", "chemistry", "code"]);
export type Checker = z.infer<typeof Checker>;

/** A verified verdict about one line of the student's work. */
export const LineCheck = z.object({
  lineId: z.string().max(80),
  checker: Checker,
  verdict: Verdict,
  reason: z.string().max(40),
  detail: z.string().max(300).nullish(),
  /** The line being checked now (the one just written), as opposed to earlier context. */
  target: z.boolean(),
});
export type LineCheck = z.infer<typeof LineCheck>;
