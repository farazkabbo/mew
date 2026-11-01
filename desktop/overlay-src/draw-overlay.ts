import {
  type DrawShape,
  type DrawTool,
  type DrawView,
  erase,
  MAX_POINTS,
  parseBox,
  parseDrawView,
  parseLive,
  parseTool,
  type Pt,
  type Rect,
  rectPath,
  shapeStroke,
  insideBox,
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
 * The island's tool says what a stroke is: select makes a mark (freehand, or a rectangle or
 * ellipse from where the drag began to where it ends); the pen writes the student's own notes,
 * which stay on this page only (never sent, never captured: this window is excluded from
 * captures); the eraser rubs out the notes it touches.
 *
 * Keyboard drawing (silent mode, §4): Tab and Shift+Tab move between the screen's text blocks
 * (nearest the pointer first), Space marks the highlighted one; Shift+arrows grow a box from the
 * pointer and Enter marks it. Each change is announced (the hint is a live region).
 */

/** Red: stands out from the screen's blue text selection (and from the tutor's ink). */
const STUDENT_INK = "#e02424";
/** The student's own notes: blue, like a pen, and unlike the marks Neb looks at. */
const NOTE_INK = "#1f6feb";
/** How near the eraser must come to a note to rub it out (CSS px). */
const ERASE_RADIUS = 14;
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
/** The answer card's pointer line into the circle (NEB_APP_UI §5.4), while the card shows. */
let pointerLine: { from: Pt; to: Pt } | null = null;
/** neb's violet (`--neb`): the line is neb's, not the student's ink. */
const NEB = "#6b4ee6";
/** The island's tool and select shape, and the student's notes (pen strokes). */
let tool: DrawTool = "none";
let shape: DrawShape = "free";
let notes: Pt[][] = [];
/** Where the island is on this page (left, top, right, bottom), while it shows. */
let island: unknown = null;
/**
 * How far the page under the notes has scrolled since they were begun (CSS px, from Rust's
 * `note_scroll.rs`): notes are kept where they'd be with no scrolling and drawn moved by this,
 * so they stay on what they were written on.
 */
let shift: Pt = [0, 0];
const shifted = (note: readonly Pt[]): Pt[] => note.map(([x, y]) => [x + shift[0], y + shift[1]]);

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
  for (const note of notes) line(shifted(note), NOTE_INK);
  for (const mark of view.marks) {
    line(mark.points, ink, mark.dashed === true);
    badge(mark.number, mark.points[0], ink);
  }
  if (stroke && tool === "pen")
    line(
      stroke.map(([x, y]) => [x, y] as Pt),
      NOTE_INK,
    );
  else if (stroke && tool !== "eraser") {
    // A rectangle or ellipse shows its shape as it's dragged.
    const shaped = tool === "select" && shape !== "free";
    const drawn = shaped ? shapeStroke(shape, stroke) : stroke;
    line(
      (drawn ?? stroke).map(([x, y]) => [x, y] as Pt),
      ink,
      shaped,
    );
  }
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
  if (pointerLine) {
    ctx.lineWidth = 3;
    ctx.lineCap = "round";
    ctx.strokeStyle = NEB;
    ctx.beginPath();
    ctx.moveTo(...pointerLine.from);
    ctx.lineTo(...pointerLine.to);
    ctx.stroke();
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
      announce("Marked. Tab to another, or double-tap Ctrl+Alt to stop drawing and ask.");
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
    announce("Marked. Double-tap Ctrl+Alt to stop drawing and ask.");
  }
  paint();
});

/** Dots and gaps for a rectangle or ellipse (CSS px). */
const DOTTED = [2, 7];

function line(points: readonly Pt[], color: string, dotted = false): void {
  if (!ctx || points.length === 0) return;
  ctx.setLineDash(dotted ? DOTTED : []);
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
  ctx.setLineDash([]);
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

/** The eraser passed `at`: the notes it touched go. */
function rubOut(at: Pt): void {
  const left = erase(notes, [at[0] - shift[0], at[1] - shift[1]], ERASE_RADIUS);
  if (left.length !== notes.length) notes = left;
}

// A pen or finger draws here: Windows mustn't take the stroke for a pan, or a long press for a
// right click (either ends the stroke early, or opens a menu over the screen).
document.documentElement.style.touchAction = "none";
window.addEventListener("contextmenu", (event) => {
  event.preventDefault();
});

// Rust can't always see where a Windows Ink pen is, hovering or drawing: its pointer follows this.
let penSent = 0;
/** About a frame. By the clock: animation frames may not run in a window that's never activated. */
const PEN_EVERY_MS = 16;
window.addEventListener("pointermove", (event) => {
  if (event.pointerType !== "pen" || event.timeStamp - penSent < PEN_EVERY_MS) return;
  penSent = event.timeStamp;
  void invoke("screen_draw_pen", { at: [event.clientX, event.clientY] }).catch(() => undefined);
});

window.addEventListener("pointerdown", (event) => {
  if (event.pointerType === "mouse") return; // Rust reads the mouse
  // This page can be above the island: a press on its buttons is theirs, never a stroke.
  if (insideBox(island, event.clientX, event.clientY)) {
    void invoke("screen_draw_island_press", { at: [event.clientX, event.clientY] }).catch(
      () => undefined,
    );
    return;
  }
  if (isEraser(event) && tool === "pen") {
    rubOut([event.clientX, event.clientY]);
    paint();
    return;
  }
  if (isEraser(event)) {
    void invoke("screen_draw_erase").catch(() => undefined);
    return;
  }
  if (view.mode === "select") {
    box = { from: [event.clientX, event.clientY], to: [event.clientX, event.clientY] };
  } else if (view.drawing && (!view.grey || tool === "pen" || tool === "eraser")) {
    // Notes are never looked at, so a refused app only stops marks.
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
    for (const each of events.length > 0 ? events : [event]) {
      stroke.push(point(each));
      if (tool === "eraser") rubOut([each.clientX, each.clientY]);
    }
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
  } else if (stroke && (tool === "pen" || tool === "eraser")) {
    // Rust didn't see this one (pen and touch are the page's): it's told where the note began,
    // to follow the page under it as it scrolls.
    const [first] = stroke;
    if (tool === "pen" && first) {
      void invoke("screen_draw_note", { at: [first[0], first[1]] }).catch(() => undefined);
    }
    endNote();
  } else if (stroke) {
    const marked = shapeStroke(tool === "select" ? shape : "free", stroke);
    if (marked) {
      const dashed = tool === "select" && shape !== "free";
      void invoke("screen_draw_mark", { stroke: { points: marked, dashed } }).catch(
        () => undefined,
      );
    }
    // Kept on screen until Rust's view (with the mark understood and numbered) arrives.
    if (!marked) stroke = null;
  }
  paint();
});

// Windows took the pen back mid-stroke: nothing half-drawn stays, and the next stroke starts clean.
window.addEventListener("pointercancel", (event) => {
  if (event.pointerType === "mouse") return;
  window.removeEventListener("pointermove", onMove);
  box = null;
  stroke = null;
  paint();
});

/** A pen or eraser stroke ended: the pen's becomes a note (on this page only). */
function endNote(): void {
  if (stroke && tool === "pen" && stroke.length > 0) {
    notes = [...notes, stroke.map(([x, y]) => [x - shift[0], y - shift[1]] as Pt)];
  }
  stroke = null;
}

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
  for (const [x, y] of live.points) {
    if (stroke.length < MAX_POINTS) stroke.push([x, y, 0.5]);
    if (tool === "eraser") rubOut([x, y]);
  }
  paint();
});

// The island's tool and select shape.
on("mew:draw-tool", (detail) => {
  const next = parseTool(detail);
  if (!next) return;
  island = (detail as { island?: unknown }).island ?? null;
  if (next.tool !== tool) stroke = null;
  ({ tool, shape } = next);
  document.body.dataset.tool = tool;
  paint();
});

// A mouse stroke of the pen or eraser ended (Rust reads the mouse).
on("mew:draw-note-end", () => {
  endNote();
  paint();
});

// The page under the notes scrolled: they move with it.
on("mew:draw-notes-shift", (detail) => {
  const { dx, dy } = (detail ?? {}) as { dx?: unknown; dy?: unknown };
  if (typeof dx !== "number" || typeof dy !== "number") return;
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
  shift = [dx, dy];
  paint();
});

// The island's Clear (or Close): the notes go.
on("mew:draw-clear-notes", () => {
  notes = [];
  shift = [0, 0];
  stroke = null;
  paint();
});

// The question box being dragged with the mouse.
on("mew:draw-box", (detail) => {
  const next = parseBox(detail);
  if (!next) return;
  box = next;
  paint();
});

// The answer card's pointer line (null when the card goes).
on("mew:draw-pointer", (detail) => {
  pointerLine = detail === null ? null : parseBox(detail);
  paint();
});

on("mew:draw-fade", () => {
  canvas?.classList.add("faded");
  window.setTimeout(() => {
    // Only the marks fade (the content moved); the student's notes stay until cleared.
    view = { ...view, marks: [] };
    stroke = null;
    canvas?.classList.remove("faded");
    paint();
  }, FADE_MS);
});

window.addEventListener("resize", resize);
resize();
