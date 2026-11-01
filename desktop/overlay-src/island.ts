import {
  ACTIVITY_LABEL,
  CLOSED_HEIGHT,
  type Control,
  EAR,
  notchPath,
  RADIUS,
  type IslandView,
  type MusicView,
  parseIslandView,
  parseMusicView,
  PIN_KIND_LABEL,
  type PinView,
  type Shape,
  SHAPE_LABEL,
  TIP_DELAY_MS,
  type Tool,
  pressedByPen,
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
 * The shapes menu and the music panel open inside the island (one at a time): the island is
 * drawn taller, as tall as what it shows, in a window that's always tall enough, and closes
 * again when a shape is picked or the music button is pressed again.
 *
 * The music panel (`screen_music.rs`) shows what's playing on this PC with its playback buttons,
 * and the student's pinned Spotify playlists. The island can't be typed into (it never takes the
 * focus), so a playlist is pinned from a link the student copied in Spotify.
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
const musicButton = document.getElementById("island-music") as HTMLButtonElement | null;
const musicPanel = document.getElementById("island-music-panel");
const art = document.getElementById("music-art") as HTMLImageElement | null;
const artEmpty = document.getElementById("music-art-empty");
const title = document.getElementById("music-title");
const artist = document.getElementById("music-artist");
const previous = document.getElementById("music-previous") as HTMLButtonElement | null;
const play = document.getElementById("music-play") as HTMLButtonElement | null;
const playIcon = document.getElementById("music-play-icon");
const next = document.getElementById("music-next") as HTMLButtonElement | null;
const pinList = document.getElementById("music-pins");
const notice = document.getElementById("music-notice");
const pinButton = document.getElementById("music-pin") as HTMLButtonElement | null;

const PLAY_PATH = "M8 5.5v13l10.5-6.5z";
const PAUSE_PATH = "M8 5.5v13M16 5.5v13";

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
  // A pen's tip touching down is its press. With Windows Ink it isn't a mouse press, so Rust doesn't
  // see it, and this never-activated window may never get the click that would follow.
  button.addEventListener("pointerdown", (event) => {
    if (pressedByPen(event)) act(button, run);
  });
  button.addEventListener("click", (event) => {
    // The press already acted, however long the tip stayed down.
    if (!pressedByPen(event)) act(button, run);
  });
}

/** What's open below the tools: the shapes menu, the music panel, or nothing. */
type Panel = "none" | "menu" | "music";

function openPanel(): Panel {
  const panel = bar?.dataset.panel;
  return panel === "menu" || panel === "music" ? panel : "none";
}

/** The island's height with what's open below the tools (CSS px), as tall as its content. */
function islandHeight(): number {
  const panel = openPanel();
  const element = panel === "menu" ? menu : panel === "music" ? musicPanel : null;
  const bottom = element ? element.getBoundingClientRect().bottom : CLOSED_HEIGHT;
  return Math.min(Math.ceil(bottom), window.innerHeight);
}

/**
 * The island, drawn in the top of its window: the bar alone, or the bar and what's open below
 * it. The window never resizes; what's below the island is clear (clicks reach the app).
 */
const outline = document.getElementById("island-shape");
function drawShape(): void {
  const open = openPanel() !== "none";
  outline?.setAttribute(
    "d",
    notchPath(window.innerWidth, islandHeight(), EAR, open ? RADIUS.open : RADIUS.closed),
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
  if (!tip || !name || openPanel() !== "none") return;
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
  if (open) setMusic(false);
  menu.hidden = !open;
  if (bar) bar.dataset.panel = open ? "menu" : "none";
  hideTip();
  drawShape();
  caret.setAttribute("aria-expanded", String(open));
  send({ type: "menu", open });
}

/** The height Rust was last told the music panel makes the island (presses there are clicks). */
let sentMusicHeight = 0;

function setMusic(open: boolean): void {
  if (!musicPanel || !musicButton || musicPanel.hidden === !open) return;
  if (open) setMenu(false);
  musicPanel.hidden = !open;
  if (bar) bar.dataset.panel = open ? "music" : "none";
  musicButton.setAttribute("aria-expanded", String(open));
  hideTip();
  drawShape();
  sentMusicHeight = open ? islandHeight() : 0;
  send({ type: "music_panel", open, height: sentMusicHeight });
}

/** The music panel changed size (a pin came or went, a notice): redraw, and tell Rust. */
function musicResized(): void {
  if (openPanel() !== "music") return;
  drawShape();
  const height = islandHeight();
  if (height !== sentMusicHeight) {
    sentMusicHeight = height;
    send({ type: "music_panel", open: true, height });
  }
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
  if (musicPanel) musicPanel.hidden = true;
  musicButton?.setAttribute("aria-expanded", "false");
  if (bar) bar.dataset.panel = "none";
  drawShape();
  send({ type: "close" });
});

// ─── Music ───────────────────────────────────────────────────────────────────────────────────

function control(button: HTMLButtonElement | null, which: Control): void {
  onPress(button, () => {
    send({ type: "music_control", control: which });
  });
}

onPress(musicButton, () => {
  setMusic(musicPanel?.hidden === true);
});
control(previous, "previous");
control(play, "play_pause");
control(next, "next");
onPress(pinButton, () => {
  send({ type: "music_pin" });
});

function pinItem(pin: PinView): HTMLLIElement {
  const item = document.createElement("li");
  const open = document.createElement("button");
  open.type = "button";
  open.className = "music-open";
  const name = document.createElement("span");
  name.className = "music-pin-name";
  name.textContent = pin.name;
  const kind = document.createElement("span");
  kind.className = "music-pin-kind";
  kind.textContent = PIN_KIND_LABEL[pin.kind];
  open.append(name, kind);
  open.setAttribute("aria-label", `Open ${pin.name} in Spotify`);
  onPress(open, () => {
    send({ type: "music_open", id: pin.id });
  });
  const unpin = document.createElement("button");
  unpin.type = "button";
  unpin.className = "music-unpin";
  unpin.setAttribute("aria-label", `Unpin ${pin.name}`);
  const icon = document.createElementNS(SVG, "svg");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("aria-hidden", "true");
  icon.append(path("M8 8l8 8M16 8l-8 8"));
  unpin.append(icon);
  onPress(unpin, () => {
    send({ type: "music_unpin", id: pin.id });
  });
  item.append(open, unpin);
  return item;
}

function renderMusic(view: MusicView): void {
  const now = view.now;
  if (musicButton) musicButton.dataset.playing = String(now?.playing === true);
  if (title) title.textContent = now ? now.title : "Nothing playing";
  if (artist) {
    artist.textContent = now
      ? [now.artist, now.player].filter(Boolean).join(" · ")
      : "Play something in Spotify or your browser";
  }
  if (art && artEmpty) {
    if (now?.art) {
      art.src = now.art;
      art.hidden = false;
      artEmpty.hidden = true;
    } else {
      art.removeAttribute("src");
      art.hidden = true;
      artEmpty.hidden = false;
    }
  }
  if (play) {
    play.disabled = !now;
    play.setAttribute("aria-label", now?.playing ? "Pause" : "Play");
  }
  playIcon?.setAttribute("d", now?.playing ? PAUSE_PATH : PLAY_PATH);
  if (previous) previous.disabled = !now?.canPrevious;
  if (next) next.disabled = !now?.canNext;

  for (const old of pinList?.querySelectorAll("button") ?? []) actions.delete(old);
  pinList?.replaceChildren(...view.pins.map(pinItem));
  if (pinList) pinList.hidden = view.pins.length === 0;
  if (notice) {
    notice.textContent = view.notice ?? "";
    notice.hidden = !view.notice;
  }
  if (pinButton) {
    pinButton.disabled = view.pinning;
    pinButton.textContent = view.pinning ? "Pinning…" : "Pin copied Spotify link";
  }
  musicResized();
}

// Shown again (hidden by the double tap last time, with something open): start closed.
on("mew:island-reset", () => {
  setMenu(false);
  setMusic(false);
  drawShape();
});

on("mew:island-music", (detail) => {
  const view = parseMusicView(detail);
  if (view) renderMusic(view);
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

// Until Rust's first view: the freehand icon, nothing pressed, nothing playing.
shapeIcon?.replaceChildren(path(SHAPE_PATHS.free));
renderMusic({ now: null, pins: [], notice: null, pinning: false });
