import { type CardAction, type CardLayout, cardLayout } from "./card-view";
import { invoke, on } from "./tauri";

/**
 * The Circle & Ask card (S3.2 §2.3–2.5): the ask bar beside the marks, then the caption of
 * each step with Pause · Repeat · Next · Stop, then the save toast. Rust sends what to show
 * (`circle_answer.rs`); `cardLayout` checks it and lays it out; this page draws it with text
 * nodes only and sends the buttons back.
 *
 * The window doesn't take the focus when it appears; clicking it gives it the keyboard (to type).
 * Keys: Enter asks (or explains, with nothing typed), Space pauses or resumes, Esc stops.
 */

const card = document.getElementById("card");
const top = document.getElementById("card-top");
const text = document.getElementById("card-text");
const chips = document.getElementById("card-chips");
const form = document.getElementById("card-ask") as HTMLFormElement | null;
const input = document.getElementById("card-input") as HTMLInputElement | null;
const buttons = document.getElementById("card-buttons");

let layout: CardLayout | null = null;
let countdown = 0;

function act(action: CardAction, words?: string): void {
  for (const b of buttons?.querySelectorAll("button") ?? []) b.disabled = true;
  void invoke("screen_circle_card", { action, ...(words !== undefined && { text: words }) }).catch(
    () => undefined,
  );
}

function render(next: CardLayout): void {
  if (!card || !top || !text || !chips || !form || !input || !buttons) return;
  layout = next;
  card.dataset.mode = next.mode;
  top.textContent = next.top;
  text.textContent = next.text;
  chips.replaceChildren(
    ...next.chips.map((question) => {
      const item = document.createElement("li");
      const chip = document.createElement("button");
      chip.type = "button";
      chip.textContent = question;
      chip.addEventListener("click", () => {
        act("confirm", question);
      });
      item.append(chip);
      return item;
    }),
  );
  form.hidden = next.input === null;
  if (next.input) {
    input.placeholder = next.input.placeholder;
    input.value = next.input.value;
  }
  buttons.replaceChildren(
    ...next.buttons.map(({ action, label, primary }) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.dataset.action = action;
      if (primary) button.className = "primary";
      button.addEventListener("click", () => {
        const words = action === "ask" || action === "confirm" ? input.value : undefined;
        act(action, words);
      });
      return button;
    }),
  );
  startCountdown(next.countdown);
}

/** The toast's seconds, counted down on the card (Rust saves when its own timer ends). */
function startCountdown(seconds: number | null): void {
  window.clearInterval(countdown);
  if (seconds === null || !top || !layout) return;
  let left = seconds;
  const base = layout.top;
  top.textContent = `${base} · ${left}`;
  countdown = window.setInterval(() => {
    left -= 1;
    if (left <= 0) window.clearInterval(countdown);
    top.textContent = left > 0 ? `${base} · ${left}` : base;
  }, 1000);
}

form?.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!layout?.input || !input) return;
  act(layout.input.action, input.value);
  input.value = "";
});

window.addEventListener("keydown", (event) => {
  const typing = document.activeElement === input && (input?.value ?? "") !== "";
  if (event.key === "Escape") {
    act(layout?.mode === "explain" ? "stop" : "close");
  } else if (event.key === " " && layout?.mode === "explain" && !typing) {
    event.preventDefault();
    act(layout.buttons.some((b) => b.action === "resume") ? "resume" : "pause");
  }
});

on("mew:card-show", (detail) => {
  const next = cardLayout(detail);
  if (next) render(next);
});
