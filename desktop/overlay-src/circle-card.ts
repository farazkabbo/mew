import { type CardAction, type CardLayout, cardKey, cardLayout, filterPlaces } from "./card-view";
import { invoke, on } from "./tauri";

/**
 * The Circle & Ask card (S3.2 §2.3–2.5): the ask bar beside the marks, then the caption of
 * each step with Pause · Repeat · Next · Stop, then the save toast. Rust sends what to show
 * (`circle_answer.rs`); `cardLayout` checks it and lays it out; this page draws it with text
 * nodes only and sends the buttons back.
 *
 * The window doesn't take the focus when it appears; clicking it gives it the keyboard (to type).
 * Keys (two at most, K2): Enter asks (or explains, with nothing typed), Ctrl+S saves without an
 * explanation, Ctrl+D changes where it's saved (K3), → and ← go to the next step or repeat this
 * one and Space pauses or resumes (when not typing), Esc stops.
 */

const card = document.getElementById("card");
const top = document.getElementById("card-top");
const text = document.getElementById("card-text");
const chips = document.getElementById("card-chips");
const placeLine = document.getElementById("card-place-line");
const placeChips = document.getElementById("card-place-chips");
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

function chip(label: string, onClick: () => void): HTMLLIElement {
  const item = document.createElement("li");
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.addEventListener("click", onClick);
  item.append(button);
  return item;
}

/** The picker's places (K3), filtered by what's typed: picked by their index in the full list. */
function showPlaces(query: string): void {
  if (!chips || layout?.mode !== "place") return;
  const all = layout.chips;
  chips.replaceChildren(
    ...filterPlaces(all, query).map((index) =>
      chip(all[index] ?? "", () => {
        act("pick_place", String(index));
      }),
    ),
  );
}

function render(next: CardLayout): void {
  if (!card || !top || !text || !chips || !form || !input || !buttons) return;
  if (!placeLine || !placeChips) return;
  layout = next;
  card.dataset.mode = next.mode;
  top.textContent = next.top;
  text.textContent = next.text;
  if (next.mode === "place") showPlaces("");
  else
    chips.replaceChildren(
      ...next.chips.map((q) =>
        chip(q, () => {
          act("confirm", q);
        }),
      ),
    );
  // Where it's saved (K3): the line, then the offered places and "Change ▾".
  placeLine.textContent = next.place?.line ?? "";
  placeChips.replaceChildren(
    ...(next.place?.chips ?? []).map((place) =>
      chip(place.label, () => {
        act(place.action, place.index === undefined ? undefined : String(place.index));
      }),
    ),
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
  if (next.mode === "place") input.focus();
  startCountdown(next.countdown);
  fit();
}

input?.addEventListener("input", () => {
  showPlaces(input.value);
});

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
  // In the picker, Enter takes the first place that matches.
  if (layout.mode === "place") {
    const [first] = filterPlaces(layout.chips, input.value);
    if (first !== undefined) act("pick_place", String(first));
    return;
  }
  act(layout.input.action, input.value);
  input.value = "";
});

window.addEventListener("keydown", (event) => {
  const typing = document.activeElement === input && (input?.value ?? "") !== "";
  const action = cardKey(event, layout, typing);
  if (!action) return;
  if (action !== "stop" && action !== "close") event.preventDefault();
  act(action);
});

/**
 * The window fits the card: taller when it shows more (where it's saved, a long caption, the
 * follow-up box), so nothing is cut off; the desktop app keeps it on the monitor and caps it,
 * and past that the caption scrolls.
 */
let fitted = 0;
function fit(): void {
  if (!card) return;
  const body = getComputedStyle(document.body);
  // The caption shrinks (and scrolls) in a short window: what it hides is room still wanted.
  const hidden = text ? text.scrollHeight - text.clientHeight : 0;
  const wanted = Math.ceil(
    card.scrollHeight + hidden + parseFloat(body.paddingTop) + parseFloat(body.paddingBottom),
  );
  if (Math.abs(wanted - fitted) < 2) return;
  fitted = wanted;
  void invoke("screen_circle_card", { action: "fit", text: String(wanted) }).catch(() => undefined);
}
if (card) {
  const watch = new ResizeObserver(fit);
  watch.observe(card);
  if (text) watch.observe(text);
}

on("mew:card-show", (detail) => {
  const next = cardLayout(detail);
  if (next) render(next);
});
