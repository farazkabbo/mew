import { parsePillView, type PillState } from "./pill-view";
import { invoke, on } from "./tauri";

/**
 * The progress pill (coach mode, S4, brief §10): "Step 3 of ~7 · Pivot tables" with the
 * walkthrough's buttons. Rust sends what to show (`walkthrough::PillView`); this page checks it
 * again and renders it with text nodes only. Its window never takes focus (the student's app
 * stays active), so everything here works with the mouse, pen or touch; the same things can be
 * said over the hotkey ("done", "I'm stuck", "stop").
 *
 * A click disables the buttons until Rust sends the next view: one event at a time.
 */

type Action = "done" | "hint" | "yes" | "no" | "pause" | "resume" | "stop" | "close";
type Button = { action: Action; label: string; primary?: boolean; hint?: string };

/** The buttons for each state (the first is the main one). */
const BUTTONS: Record<PillState, Button[]> = {
  awaiting: [
    { action: "done", label: "Done", primary: true, hint: "Check this step" },
    { action: "hint", label: "Hint", hint: "Help with this step" },
    { action: "pause", label: "Pause" },
    { action: "stop", label: "Stop", hint: "Stop the walkthrough (you can continue it later)" },
  ],
  confirming: [
    { action: "yes", label: "Yes", primary: true, hint: "Yes, this step is done" },
    { action: "no", label: "No", hint: "No, it isn't done yet" },
    { action: "stop", label: "Stop" },
  ],
  paused: [
    { action: "resume", label: "Resume", primary: true },
    { action: "stop", label: "Stop" },
  ],
  busy: [],
  finished: [{ action: "close", label: "Close" }],
};

const pill = document.getElementById("coach-pill");
const title = document.getElementById("coach-title");
const progress = document.getElementById("coach-progress");
const status = document.getElementById("coach-status");
const buttons = document.getElementById("coach-buttons");

function render(detail: unknown): void {
  const view = parsePillView(detail);
  if (!view || !pill || !title || !progress || !status || !buttons) return;
  pill.dataset.state = view.state;
  title.textContent = view.title;
  progress.textContent = view.progress;
  status.textContent =
    view.state === "busy"
      ? "Checking…"
      : view.state === "confirming"
        ? "Is it done?"
        : view.state === "paused"
          ? "Paused"
          : (view.summary ?? "");
  buttons.replaceChildren(...BUTTONS[view.state].map(button));
}

function button({ action, label, primary, hint }: Button): HTMLButtonElement {
  const element = document.createElement("button");
  element.type = "button";
  element.textContent = label;
  element.dataset.action = action;
  if (primary) element.className = "primary";
  if (hint) element.title = hint;
  element.addEventListener("click", () => {
    for (const b of buttons?.querySelectorAll("button") ?? []) b.disabled = true;
    void invoke("screen_coach_pill", { action }).catch(() => undefined);
  });
  return element;
}

on("mew:coach-pill-show", render);
