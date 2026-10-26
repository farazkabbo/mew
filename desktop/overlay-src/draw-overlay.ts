import {
  type DrawView,
  MAX_POINTS,
  parseBox,
  parseDrawView,
  parseLive,
  type Pt,
  type Rect,
  rectPath,
} from "./draw-view";
import { invoke, on } from "./tauri";

/**
 * The draw overlay (Circle & Ask, S3.2 §2.2, §3.5): a transparent window over one monitor.
 * It only takes the mouse, pen and touch while the student draws (Rust switches it); then each
 * finished stroke goes to Rust, which understands it and sends back every mark to show (with its
 * number). In "select" mode a drag is a box around a question on screen instead.
 *
 * It never sees the screen: only the marks' paths, in CSS pixels of this window.
 *
 * The mouse is read by Rust (screen/drag.rs: a never-activated window's webview doesn't reliably
 * get it), which sends the stroke or box as it's dragged; this page draws pen and touch itself
 * (they report pressure) and ignores the mouse.
 *
 * Keyboard drawing (silent mode, §4): Tab and Shift+Tab move between the screen's text blocks
 * (nearest the pointer first), Space marks the highlighted one; Shift+arrows grow a box from the
 * pointer and Enter marks it. Each change is announced (the hint is a live region).
 */

/** Red: stands out from the screen's blue text selection (and from the tutor's ink). */
const STUDENT_INK = "#e02424";
const GREY_INK = "#9a9a9a";
const FADE_MS = 200;

const canvas = document.querySelector("canvas");
const ctx = canvas?.getContext("2d") ?? null;
const hint = document.getElementById("draw-hint");

let view: DrawView = {
  marks: [],
  grey: false,
  drawing: false,
  mode: "draw",
  blocks: [],
  pointer: null,
};
/** Keyboard drawing: the highlighted block, and the box being grown. */
let highlighted = -1;
let keyBox: Rect | null = null;
/** How far Shift+arrow grows the box (CSS px). */
const GROW = 16;
/** The stroke being drawn (shown at once; Rust's next view includes it once it's understood). */
let stroke: [number, number, number][] | null = null;
/** The box being dragged in select mode. */
let box: { from: Pt; to: Pt } | null = null;

function resize(): void {
  if (!canvas) return;
  canvas.width = Math.round(window.innerWidth * window.devicePixelRatio);
  canvas.height = Math.round(window.innerHeight * window.devicePixelRatio);
  paint();
}

function paint(): void {
  if (!canvas || !ctx) return;
  const ratio = window.devicePixelRatio;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const ink = view.grey ? GREY_INK : STUDENT_INK;
  for (const mark of view.marks) {
    line(mark.points, ink);
    badge(mark.number, mark.points[0], ink);
  }
  if (stroke)
    line(
      stroke.map(([x, y]) => [x, y] as Pt),
      ink,
    );
  if (view.mode === "keyboard") {
    const block = view.blocks[highlighted];
    ctx.lineWidth = 3;
    ctx.strokeStyle = STUDENT_INK;
    if (block) ctx.strokeRect(block[0] - 4, block[1] - 4, block[2] + 8, block[3] + 8);
    if (keyBox) {
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(...keyBox);
      ctx.setLineDash([]);
    }
  }
  if (box) {
    const [x0, y0] = box.from;
    const [x1, y1] = box.to;
    ctx.setLineDash([6, 4]);
    ctx.lineWidth = 2;
    ctx.strokeStyle = STUDENT_INK;
    ctx.strokeRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
    ctx.setLineDash([]);
  }
  document.body.classList.toggle("capturing", view.drawing || view.mode !== "draw");
}

function announce(text: string): void {
  if (hint) hint.textContent = text;
}

function markRect(rect: Rect): void {
  void invoke("screen_draw_mark", { stroke: { points: rectPath(rect) } }).catch(() => undefined);
}

window.addEventListener("keydown", (event) => {
  if (view.mode !== "keyboard") return;
  const blocks = view.blocks;
  if (event.key === "Tab" && blocks.length > 0) {
    event.preventDefault();
    highlighted = (highlighted + (event.shiftKey ? blocks.length - 1 : 1)) % blocks.length;
    keyBox = null;
    announce(`Text block ${highlighted + 1} of ${blocks.length}. Space to mark it.`);
  } else if (event.key === " ") {
    event.preventDefault();
    const block = blocks[highlighted];
    if (block) {
      markRect(block);
      announce("Marked. Tab to another, or double-tap Ctrl+Alt to ask.");
    }
  } else if (event.shiftKey && event.key.startsWith("Arrow")) {
    event.preventDefault();
    const [px, py] = view.pointer ?? [window.innerWidth / 2, window.innerHeight / 2];
    const [x, y, w, h] = keyBox ?? [px, py, 0, 0];
    const grow: Record<string, Rect> = {
      ArrowRight: [x, y, w + GROW, h],
      ArrowLeft: [x, y, Math.max(0, w - GROW), h],
      ArrowDown: [x, y, w, h + GROW],
      ArrowUp: [x, y, w, Math.max(0, h - GROW)],
    };
    keyBox = grow[event.key] ?? keyBox;
    highlighted = -1;
    announce("Box. Shift and the arrows grow it; Enter marks it.");
  } else if (event.key === "Enter" && keyBox && keyBox[2] >= 8 && keyBox[3] >= 8) {
    event.preventDefault();
    markRect(keyBox);
    keyBox = null;
    announce("Marked. Double-tap Ctrl+Alt to ask.");
  }
  paint();
});

function line(points: readonly Pt[], color: string): void {
  if (!ctx || points.length === 0) return;
  ctx.lineWidth = 3;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = color;
  ctx.beginPath();
  points.forEach(([x, y], i) => {
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  const [only] = points;
  // A tap is one point: a dot.
  if (points.length === 1 && only) ctx.lineTo(only[0] + 0.1, only[1]);
  ctx.stroke();
}

/** The mark's number in a small circle by where it starts (brief §2.2). */
function badge(number: number, at: Pt | undefined, color: string): void {
  if (!ctx || !at) return;
  const [x, y] = [at[0] - 12, at[1] - 12];
  ctx.beginPath();
  ctx.arc(x, y, 9, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.font = "600 12px 'Segoe UI Variable Text', 'Segoe UI', sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(String(number), x, y + 0.5);
}

function point(event: PointerEvent): [number, number, number] {
  // A mouse reports no pressure: 0.5, like the notebook.
  const pressure = event.pointerType === "mouse" || event.pressure === 0 ? 0.5 : event.pressure;
  return [event.clientX, event.clientY, Math.min(1, Math.max(0, pressure))];
}

/** The pen's eraser end (button 5, or the eraser button held). */
function isEraser(event: PointerEvent): boolean {
  return event.pointerType === "pen" && (event.button === 5 || (event.buttons & 32) !== 0);
}

window.addEventListener("pointerdown", (event) => {
  if (event.pointerType === "mouse") return; // Rust reads the mouse
  if (isEraser(event)) {
    void invoke("screen_draw_erase").catch(() => undefined);
    return;
  }
  if (view.mode === "select") {
    box = { from: [event.clientX, event.clientY], to: [event.clientX, event.clientY] };
  } else if (view.drawing && !view.grey) {
    stroke = [point(event)];
  }
  window.addEventListener("pointermove", onMove);
  paint();
});

function onMove(event: PointerEvent): void {
  if (box) box.to = [event.clientX, event.clientY];
  else if (stroke) {
    // Pens report more points than frames: keep them all (smoother marks). Only secure
    // contexts have them; elsewhere the event itself is the point.
    let events: PointerEvent[] = [];
    try {
      events = event.getCoalescedEvents();
    } catch {
      events = [];
    }
    for (const each of events.length > 0 ? events : [event]) stroke.push(point(each));
  }
  paint();
}

window.addEventListener("pointerup", (event) => {
  // The stroke or box on show may be the mouse's, which Rust finishes itself.
  if (event.pointerType === "mouse") return;
  window.removeEventListener("pointermove", onMove);
  if (box) {
    const [x0, y0] = box.from;
    const [x1, y1] = box.to;
    box = null;
    const rect = [Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0)];
    void invoke("screen_draw_select", { rect }).catch(() => undefined);
  } else if (stroke) {
    void invoke("screen_draw_mark", { stroke: { points: stroke } }).catch(() => undefined);
    // Kept on screen until Rust's view (with the mark understood and numbered) arrives.
  }
  paint();
});

on("mew:draw-show", (detail) => {
  const next = parseDrawView(detail);
  if (!next) return;
  // A select-only update keeps the marks it doesn't mention.
  view = { ...view, ...next, marks: next.marks ?? view.marks };
  if (next.mode !== "keyboard") {
    highlighted = -1;
    keyBox = null;
  } else if (next.blocks) {
    announce(
      next.blocks.length > 0
        ? "Drawing with the keyboard. Tab to a text block, or Shift and the arrows for a box."
        : "Drawing with the keyboard. Shift and the arrows make a box; Enter marks it.",
    );
  }
  stroke = null;
  box = null;
  canvas?.classList.remove("faded");
  if (hint && view.mode !== "keyboard") {
    hint.textContent =
      view.mode === "select"
        ? "Drag a box around your question."
        : view.grey
          ? "I can't look at this app."
          : "";
  }
  paint();
});

// The mouse stroke being drawn, a point at a time (Rust reads the mouse).
on("mew:draw-live", (detail) => {
  const live = parseLive(detail);
  if (!live) return;
  if (live.start || !stroke) stroke = [];
  for (const [x, y] of live.points) if (stroke.length < MAX_POINTS) stroke.push([x, y, 0.5]);
  paint();
});

// The question box being dragged with the mouse.
on("mew:draw-box", (detail) => {
  const next = parseBox(detail);
  if (!next) return;
  box = next;
  paint();
});

on("mew:draw-fade", () => {
  canvas?.classList.add("faded");
  window.setTimeout(() => {
    view = { ...view, marks: [] };
    stroke = null;
    canvas?.classList.remove("faded");
    paint();
  }, FADE_MS);
});

window.addEventListener("resize", resize);
resize();
