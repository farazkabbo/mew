import { type QuizAction, type QuizLayout, quizKey, quizLayout } from "./quiz-view";
import { invoke, on } from "./tauri";

/**
 * The quiz card ("quiz me on this", Screen Coach S6): the question, a multiple choice's options or
 * a box to type the answer, then whether it was right. Rust sends what to show (`screen_quiz.rs`);
 * `quizLayout` checks it; this page draws it with text nodes only and sends the answer back.
 * Answering out loud works too: the next hold's words are the answer.
 *
 * The window doesn't take the focus when it appears; clicking it gives it the keyboard (to type).
 */

const top = document.getElementById("quiz-top");
const prompt = document.getElementById("quiz-prompt");
const choices = document.getElementById("quiz-choices");
const result = document.getElementById("quiz-result");
const form = document.getElementById("quiz-form") as HTMLFormElement | null;
const input = document.getElementById("quiz-input") as HTMLInputElement | null;
const buttons = document.getElementById("quiz-buttons");

let layout: QuizLayout | null = null;

function act(action: QuizAction, answer?: string): void {
  for (const b of document.querySelectorAll("button")) b.disabled = true;
  void invoke("screen_quiz_card", { action, ...(answer !== undefined && { text: answer }) }).catch(
    () => undefined,
  );
}

function button(label: string, onClick: () => void, primary = false): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  if (primary) b.className = "primary";
  b.addEventListener("click", onClick);
  return b;
}

function render(next: QuizLayout): void {
  if (!top || !prompt || !choices || !result || !form || !input || !buttons) return;
  layout = next;
  top.textContent = next.busy ? `${next.top} · checking…` : next.top;
  prompt.textContent = next.prompt;
  choices.replaceChildren(
    ...next.choices.map((choice, index) => {
      const item = document.createElement("li");
      item.append(
        button(`${index + 1}. ${choice}`, () => {
          act("answer", choice);
        }),
      );
      return item;
    }),
  );
  result.textContent = next.result?.text ?? "";
  result.dataset.correct = next.result ? String(next.result.correct) : "";
  form.hidden = !next.input;
  if (!next.input) input.value = "";
  buttons.replaceChildren(
    ...next.buttons.map(({ action, label, primary }) =>
      button(
        label,
        () => {
          act(action, action === "answer" ? input.value : undefined);
        },
        primary ?? false,
      ),
    ),
  );
  for (const b of document.querySelectorAll("button")) b.disabled = next.busy;
}

form?.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!layout?.input || !input || input.value.trim() === "") return;
  act("answer", input.value);
});

window.addEventListener("keydown", (event) => {
  const typing = document.activeElement === input && (input?.value ?? "") !== "";
  const picked = quizKey(event, layout, typing);
  if (!picked) return;
  event.preventDefault();
  if (picked.choice !== undefined) act("answer", layout?.choices[picked.choice]);
  else if (picked.action === "answer") form?.requestSubmit();
  else act(picked.action);
});

on("mew:quiz-show", (detail) => {
  const next = quizLayout(detail);
  if (next) render(next);
});
