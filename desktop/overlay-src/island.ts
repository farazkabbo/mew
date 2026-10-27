import {
  ACTIVITY_LABEL,
  CLOSED_HEIGHT,
  EAR,
  notchPath,
  RADIUS,
  type IslandView,
  parseIslandView,
  type Shape,
  SHAPE_LABEL,
  TIP_DELAY_MS,
  type Tool,
} from "./island-view";
import { invoke, on } from "./tauri";

/**
 * The island (`screen_island.rs`): Screen Coach's tools in a black bar at the top of the screen.
 * The pen and eraser are the student's own notes; select (with its shapes) is what Neb looks at;
 * the mic is click, speak, click again. Rust sends the view after every change and this page
 * draws it; a click sends the button back. Its window never takes the focus, so it works with
 * the mouse, pen and touch. While a tool is on, the draw overlay takes the mouse and this page
 * may not see a click, so Rust passes each press on the island (`mew:island-press`); a button
 * acts once per press however the click arrives.
 *
 * The shapes menu opens inside the island: the island grows (its window too, clipped to the
 * island's shape by Rust) and closes again when a shape is picked.
 */

const SVG = "http://www.w3.org/2000/svg";
const SHAPES: readonly Shape[] = ["free", "rect", "ellipse"];

/** Each select shape's icon (paths in a 24×24 box). */
const SHAPE_PATHS: Record<Shape, string> = {
  free: "M7.5 6.5c4-2.5 11-1 11 4.5s-7 7.5-11.5 6S2.5 9 7.5 6.5z M15 17.5l3 3",
  rect: "M4.5 5.5h15v13h-15z",
  ellipse: "M12 5.5c4.4 0 8 2.9 8 6.5s-3.6 6.5-8 6.5-8-2.9-8-6.5 3.6-6.5 8-6.5z",
};

const bar = document.getElementById("island");
const activity = document.getElementById("island-activity");
const shapeIcon = document.getElementById("island-shape-icon");
const caret = document.getElementById("island-caret");
const menu = document.getElementById("island-menu");
const mic = document.getElementById("island-mic") as HTMLButtonElement | null;
const clear = document.getElementById("island-clear") as HTMLButtonElement | null;
const close = document.getElementById("island-close");

function send(action: object): void {
  void invoke("screen_island", { action }).catch(() => undefined);
}

function path(d: string): SVGPathElement {
  const element = document.createElementNS(SVG, "path");
  element.setAttribute("d", d);
  return element;
}

/** When a button last acted: the same press may arrive twice (Rust's, then the page's click). */
let lastAct = 0;
const SAME_PRESS_MS = 450;

function act(button: HTMLButtonElement, run: () => void): void {
  if (button.disabled) return;
  const now = performance.now();
  if (now - lastAct < SAME_PRESS_MS) return;
  lastAct = now;
  run();
}

/** Each button's action (clicked, or pressed while the draw overlay has the mouse). */
const actions = new Map<Element, () => void>();

function onPress(button: HTMLButtonElement | null, run: () => void): void {
  if (!button) return;
  actions.set(button, run);
  button.addEventListener("click", () => {
    act(button, run);
  });
}

/**
 * The island, drawn in the top of its window: the bar alone, or the bar and its menu filling the
 * window. The window never resizes; what's below the island is clear (clicks reach the app).
 */
const outline = document.getElementById("island-shape");
function drawShape(): void {
  const open = bar?.dataset.open === "true";
  const height = open ? window.innerHeight : Math.min(CLOSED_HEIGHT, window.innerHeight);
  outline?.setAttribute(
    "d",
    notchPath(window.innerWidth, height, EAR, open ? RADIUS.open : RADIUS.closed),
  );
}

/** A button's name under it, after the pointer rests on it a moment. */
const tip = document.getElementById("island-tip");
let tipTimer = 0;
function hideTip(): void {
  window.clearTimeout(tipTimer);
  if (tip) tip.hidden = true;
}
function showTipFor(button: HTMLElement): void {
  hideTip();
  const name = button.dataset.tip;
  if (!tip || !name || bar?.dataset.open === "true") return;
  tipTimer = window.setTimeout(() => {
    tip.textContent = name;
    tip.hidden = false;
    const box = button.getBoundingClientRect();
    const half = tip.offsetWidth / 2;
    const centre = Math.min(
      Math.max(box.left + box.width / 2, half + 4),
      window.innerWidth - half - 4,
    );
    tip.style.left = `${centre - half}px`;
  }, TIP_DELAY_MS);
}
for (const button of document.querySelectorAll<HTMLElement>(".island-bar button")) {
  // The page's own names, never the system tooltip (it doesn't show in a window that's never
  // activated).
  button.dataset.tip = button.title || button.getAttribute("aria-label") || "";
  button.removeAttribute("title");
  button.addEventListener("pointerenter", () => {
    showTipFor(button);
  });
  button.addEventListener("pointerleave", hideTip);
  button.addEventListener("pointerdown", hideTip);
}
window.addEventListener("resize", drawShape);
drawShape();

function setMenu(open: boolean): void {
  if (!menu || !caret || menu.hidden === !open) return;
  menu.hidden = !open;
  if (bar) bar.dataset.open = String(open);
  hideTip();
  drawShape();
  caret.setAttribute("aria-expanded", String(open));
  send({ type: "menu", open });
}

function render(next: IslandView): void {
  if (bar) bar.dataset.activity = next.activity;
  if (activity) activity.textContent = ACTIVITY_LABEL[next.activity];
  for (const button of document.querySelectorAll<HTMLButtonElement>("button[data-tool]")) {
    button.setAttribute("aria-pressed", String(button.dataset.tool === next.tool));
  }
  shapeIcon?.replaceChildren(path(SHAPE_PATHS[next.shape]));
  if (mic) {
    mic.setAttribute("aria-pressed", String(next.mic));
    mic.disabled = next.silent;
    mic.dataset.tip = next.silent
      ? "Voice is off in Screen Coach settings"
      : next.mic
        ? "Microphone: click to stop and ask"
        : "Microphone: click, speak, click again";
  }
  if (clear) clear.disabled = !next.clearable;
  for (const old of menu?.querySelectorAll("button") ?? []) actions.delete(old);
  menu?.replaceChildren(...SHAPES.map((shape) => menuItem(shape, shape === next.shape)));
}

function menuItem(shape: Shape, checked: boolean): HTMLLIElement {
  const item = document.createElement("li");
  const button = document.createElement("button");
  button.type = "button";
  button.setAttribute("role", "menuitemradio");
  button.setAttribute("aria-checked", String(checked));
  const icon = document.createElementNS(SVG, "svg");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("aria-hidden", "true");
  icon.append(path(SHAPE_PATHS[shape]));
  const label = document.createElement("span");
  label.textContent = SHAPE_LABEL[shape];
  button.append(icon, label);
  onPress(button, () => {
    setMenu(false);
    send({ type: "shape", shape });
  });
  item.append(button);
  return item;
}

for (const button of document.querySelectorAll<HTMLButtonElement>("button[data-tool]")) {
  onPress(button, () => {
    setMenu(false);
    send({ type: "tool", tool: button.dataset.tool as Tool });
  });
}
onPress(caret as HTMLButtonElement | null, () => {
  setMenu(menu?.hidden === true);
});
onPress(mic, () => {
  setMenu(false);
  send({ type: "mic" });
});
onPress(clear, () => {
  setMenu(false);
  send({ type: "clear" });
});
onPress(close as HTMLButtonElement | null, () => {
  if (menu) menu.hidden = true;
  if (bar) bar.dataset.open = "false";
  send({ type: "close" });
});

// A press Rust saw while the draw overlay had the mouse: the button under it acts.
on("mew:island-press", (detail) => {
  const { x, y } = (detail ?? {}) as { x?: unknown; y?: unknown };
  if (typeof x !== "number" || typeof y !== "number") return;
  const button = document.elementFromPoint(x, y)?.closest("button");
  const run = button ? actions.get(button) : undefined;
  if (button && run) act(button, run);
});

on("mew:island-show", (detail) => {
  const next = parseIslandView(detail);
  if (next) render(next);
});

// Until Rust's first view: the freehand icon, nothing pressed.
shapeIcon?.replaceChildren(path(SHAPE_PATHS.free));
