/**
 * What the quiz card shows ("quiz me on this", Screen Coach S6), as Rust sends it (`quiz.rs`,
 * `Quiz::view`), checked by hand and turned into what to render. Pure: the page (quiz-card.ts)
 * only draws it.
 */

export type QuizAction = "answer" | "next" | "stop";

export type QuizButton = { action: QuizAction; label: string; primary?: boolean };

export type QuizLayout = {
  top: string;
  prompt: string;
  /** A multiple choice's options, each one tap to answer ([] otherwise, or once answered). */
  choices: string[];
  /** What was said back after grading, and whether it was right. */
  result: { text: string; correct: boolean } | null;
  /** The text box for a typed answer (only while asking a question that isn't a choice). */
  input: boolean;
  busy: boolean;
  buttons: QuizButton[];
};

const text = (value: unknown, max: number): string | null =>
  typeof value === "string" && value.length <= max ? value : null;

const count = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 3 ? value : null;

export function quizLayout(detail: unknown): QuizLayout | null {
  if (typeof detail !== "object" || detail === null) return null;
  const view = detail as Record<string, unknown>;
  const step = count(view.step);
  const total = count(view.total);
  const prompt = text(view.prompt, 300);
  const phase = view.phase;
  if (step === null || total === null || step > total || !prompt) return null;
  if (phase !== "asking" && phase !== "checking" && phase !== "answered") return null;
  const choices = Array.isArray(view.choices)
    ? view.choices.map((c) => text(c, 120)).filter((c): c is string => c !== null)
    : [];
  const mcq = view.kind === "mcq" && choices.length >= 2;
  const said = text(view.said, 300);
  const answered = phase === "answered" && said !== null;
  const last = view.last === true;

  return {
    top: total === 1 ? "Quiz · 1 question" : `Quiz · question ${step} of ${total}`,
    prompt,
    choices: mcq && phase === "asking" ? choices.slice(0, 4) : [],
    result: answered ? { text: said, correct: view.correct === true } : null,
    input: phase === "asking" && !mcq,
    busy: phase === "checking",
    buttons: answered
      ? [
          { action: "stop", label: "Stop" },
          { action: "next", label: last ? "Finish" : "Next ↵", primary: true },
        ]
      : [
          { action: "stop", label: "Stop" },
          { action: "next", label: "Skip" },
          ...(mcq ? [] : [{ action: "answer" as const, label: "Check ↵", primary: true }]),
        ],
  };
}

/**
 * The card's keys (two at most, K2): Enter checks a typed answer (or goes on once graded), 1–4
 * pick a choice, Esc stops. Null: not ours.
 */
export function quizKey(
  event: Pick<KeyboardEvent, "key" | "ctrlKey" | "altKey" | "metaKey">,
  layout: QuizLayout | null,
  typing: boolean,
): { action: QuizAction; choice?: number } | null {
  if (!layout || event.ctrlKey || event.altKey || event.metaKey) return null;
  if (event.key === "Escape") return { action: "stop" };
  if (layout.busy) return null;
  if (event.key === "Enter") {
    if (layout.result) return { action: "next" };
    return layout.input && typing ? { action: "answer" } : null;
  }
  const index = ["1", "2", "3", "4"].indexOf(event.key);
  if (!typing && index >= 0 && index < layout.choices.length) {
    return { action: "answer", choice: index };
  }
  return null;
}
