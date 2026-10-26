import { z } from "zod";

/**
 * A worked solution kept with a Circle & Ask entry (K7, docs/NOTEBOOKS_K.md §6.2): "just tell me
 * the answer" on screen is solved and verified on the server like in the notebook (K6), shown on
 * screen, and saved with the entry folded, with its Your Turn waiting in the notebook. Only code
 * puts one here, after verification; mirrors `SavedSolution` in backend/src/mew_api/clips/models.py.
 */
export const SAVED_SOLUTION_LIMITS = {
  steps: 6,
  textChars: 500,
  workChars: 120,
  latexChars: 200,
  whyChars: 200,
  skillChars: 80,
} as const;

const L = SAVED_SOLUTION_LIMITS;
const Latex = z.string().max(L.latexChars).nullable();
const Written = z.object({ text: z.string().min(1).max(L.textChars), latex: Latex });

export const SavedSolution = z.object({
  problem: Written,
  steps: z
    .array(
      z.object({
        work: z.string().min(1).max(L.workChars),
        latex: Latex,
        why: z.string().min(1).max(L.whyChars),
      }),
    )
    .min(1)
    .max(L.steps),
  finalAnswer: Written,
  /** The verified practice problem, or null when none could be verified. */
  yourTurn: z
    .object({
      problem: z.string().min(1).max(L.textChars),
      latex: Latex,
      answerKey: Written,
      skill: z.string().min(1).max(L.skillChars),
    })
    .nullable(),
});
export type SavedSolution = z.infer<typeof SavedSolution>;
