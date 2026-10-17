import { DEFAULT_PRESSURE } from "@mew/ink";

/** A pointer sample in CSS pixels relative to the canvas, with a DOM timestamp in ms. */
export type Sample = { x: number; y: number; pressure: number; time: number };

export type InputCallbacks = {
  onStrokeStart(sample: Sample): void;
  onStrokeMove(samples: Sample[]): void;
  onStrokeEnd(): void;
  /** The gesture turned out not to be a stroke (e.g. a second finger started a pinch). */
  onStrokeCancel(): void;
  onPan(dx: number, dy: number): void;
  onZoom(anchorX: number, anchorY: number, factor: number): void;
  /** Hover position of a mouse or pen (null when it leaves), e.g. for the eraser cursor. */
  onHover(sample: Sample | null): void;
};

type Touch = { x: number; y: number };
type Pinch = { distance: number; midX: number; midY: number };

const LINE_HEIGHT_PX = 16;

/**
 * Turns pointer, wheel and keyboard events into drawing and navigation gestures.
 *
 * - Pen pressure is used when available; mouse and touch get a constant (simulated later).
 * - Palm rejection: once a pen has been seen, touches only navigate (pan / pinch), never draw.
 * - Two fingers pinch-zoom and pan; wheel pans; ctrl/⌘+wheel (and trackpad pinch) zooms.
 * - Space+drag or the middle mouse button pans.
 */
export class PointerInput {
  private penSeen = false;
  private spaceHeld = false;
  private drawing: number | null = null;
  private panning: { id: number; x: number; y: number } | null = null;
  private readonly touches = new Map<number, Touch>();
  private pinch: Pinch | null = null;
  private origin = { left: 0, top: 0 };
  private readonly abort = new AbortController();

  constructor(
    private readonly el: HTMLElement,
    private readonly cb: InputCallbacks,
  ) {
    const opts = { signal: this.abort.signal };
    el.addEventListener("pointerdown", this.onPointerDown, opts);
    el.addEventListener("pointermove", this.onPointerMove, opts);
    el.addEventListener("pointerup", this.onPointerUp, opts);
    el.addEventListener("pointercancel", this.onPointerUp, opts);
    el.addEventListener("pointerleave", () => this.cb.onHover(null), opts);
    el.addEventListener("wheel", this.onWheel, { ...opts, passive: false });
    el.addEventListener("contextmenu", (e) => e.preventDefault(), opts);
    window.addEventListener("keydown", this.onKey, opts);
    window.addEventListener("keyup", this.onKey, opts);
    window.addEventListener("blur", () => (this.spaceHeld = false), opts);
  }

  dispose(): void {
    this.abort.abort();
  }

  private readonly onPointerDown = (e: PointerEvent): void => {
    this.origin = this.el.getBoundingClientRect();
    if (e.pointerType === "pen") this.penSeen = true;
    e.preventDefault();

    if (e.pointerType === "touch") {
      this.touches.set(e.pointerId, this.position(e));
      if (this.touches.size >= 2) {
        this.cancelDrawing();
        this.panning = null;
        this.pinch = this.measurePinch();
        return;
      }
      if (this.penSeen) {
        this.startPan(e);
        return;
      }
    }

    if (e.button === 1 || (e.button === 0 && this.spaceHeld)) {
      this.startPan(e);
      return;
    }
    if (e.button !== 0 || this.drawing !== null) return;

    this.el.setPointerCapture(e.pointerId);
    this.drawing = e.pointerId;
    this.cb.onStrokeStart(this.sample(e));
  };

  private readonly onPointerMove = (e: PointerEvent): void => {
    if (e.pointerType === "touch" && this.touches.has(e.pointerId)) {
      this.touches.set(e.pointerId, this.position(e));
      if (this.pinch) {
        this.updatePinch();
        return;
      }
    }

    if (this.panning?.id === e.pointerId) {
      const { x, y } = this.position(e);
      this.cb.onPan(x - this.panning.x, y - this.panning.y);
      this.panning = { id: e.pointerId, x, y };
      return;
    }

    if (this.drawing === e.pointerId) {
      // Coalesced events recover the samples the browser merged into this frame (smooth curves).
      const events = e.getCoalescedEvents?.() ?? [];
      this.cb.onStrokeMove((events.length > 0 ? events : [e]).map((ev) => this.sample(ev)));
      return;
    }

    if (e.pointerType !== "touch" && e.buttons === 0) {
      this.origin = this.el.getBoundingClientRect();
      this.cb.onHover(this.sample(e));
    }
  };

  private readonly onPointerUp = (e: PointerEvent): void => {
    if (this.drawing === e.pointerId) {
      this.drawing = null;
      if (e.type === "pointercancel") this.cb.onStrokeCancel();
      else this.cb.onStrokeEnd();
    }
    if (this.panning?.id === e.pointerId) this.panning = null;
    this.touches.delete(e.pointerId);
    if (this.touches.size < 2) this.pinch = null;
  };

  private readonly onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const scale = e.deltaMode === WheelEvent.DOM_DELTA_LINE ? LINE_HEIGHT_PX : 1;
    const dx = e.deltaX * scale;
    const dy = e.deltaY * scale;
    if (e.ctrlKey || e.metaKey) {
      const rect = this.el.getBoundingClientRect();
      this.cb.onZoom(e.clientX - rect.left, e.clientY - rect.top, Math.exp(-dy * 0.01));
    } else {
      this.cb.onPan(-dx, -dy);
    }
  };

  private readonly onKey = (e: KeyboardEvent): void => {
    if (e.code !== "Space" || isTypingTarget(e.target)) return;
    this.spaceHeld = e.type === "keydown";
    if (e.type === "keydown") e.preventDefault();
  };

  private startPan(e: PointerEvent): void {
    this.el.setPointerCapture(e.pointerId);
    this.panning = { id: e.pointerId, ...this.position(e) };
  }

  private cancelDrawing(): void {
    if (this.drawing === null) return;
    this.drawing = null;
    this.cb.onStrokeCancel();
  }

  private measurePinch(): Pinch | null {
    const [a, b] = [...this.touches.values()];
    if (!a || !b) return null;
    return {
      distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
      midX: (a.x + b.x) / 2,
      midY: (a.y + b.y) / 2,
    };
  }

  private updatePinch(): void {
    const previous = this.pinch;
    const next = this.measurePinch();
    if (!previous || !next) return;
    this.cb.onPan(next.midX - previous.midX, next.midY - previous.midY);
    this.cb.onZoom(next.midX, next.midY, next.distance / previous.distance);
    this.pinch = next;
  }

  private position(e: PointerEvent): Touch {
    return { x: e.clientX - this.origin.left, y: e.clientY - this.origin.top };
  }

  private sample(e: PointerEvent): Sample {
    const { x, y } = this.position(e);
    // Pens report 0 at first contact on some devices; keep a sliver so the stroke starts visibly.
    const pressure =
      e.pointerType === "pen" ? Math.max(0.05, Math.min(1, e.pressure)) : DEFAULT_PRESSURE;
    return { x, y, pressure, time: e.timeStamp };
  }
}

function isTypingTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
  );
}
