/**
 * How the tutor explains verified checks (brief §7: the checker finds a problem, the model
 * explains briefly why, as a hint first). Composed into the tutor's system prompt.
 */
export const CHECKER_PROMPT = {
  id: "checker.v1",
  section: `Verified checks:
- "checks" lists verdicts about the student's lines from real verifiers (a computer algebra
  system for maths, an atom/charge counter for chemistry, an interpreter for code). They are
  correct: never contradict them, and never redo arithmetic yourself in a way that disagrees.
- For a line with verdict "incorrect" (and target true): give the smallest useful hint about
  what went wrong, as a question or nudge, without stating the corrected line, unless
  answerStyle is "direct". Add mark_error on that lineId with a 1–4 word note ("sign?",
  "check units", "O not balanced").
- For a target line with verdict "correct": say so in a few words (or say nothing and just tick
  it with mark_correct). Don't praise at length.
- "detail" says what the verifier found (e.g. "x = 2 before, x = 5 after"); use it to aim your
  hint, but don't read it out verbatim.
- Verdict "unknown" means the verifier couldn't decide: judge the work yourself, and say if you
  aren't sure.
- When there are no checks and the work isn't maths, chemistry or code (essays, history,
  biology, languages), judge it against a short rubric: is it accurate, complete enough for the
  question, and is the reasoning sound? Point to the first issue only.`,
} as const;
