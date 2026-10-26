/**
 * Neb's one gesture on the notebook page (K2, docs/NOTEBOOKS_K.md §11.1 and decision 5): hold
 * **left Ctrl + left Alt** to talk and circle your own writing (K6). The same rules as
 * the desktop app's (`desktop/src-tauri/src/screen/hold.rs`), driven by the page's own key
 * events instead of polling: the hold starts after 300 ms with no other key, any other key
 * cancels it silently, and right Alt (AltGr, used to type "@" or "€") never counts.
 *
 * A web page only sees keys while it has the focus, so in a browser this works on the notebook
 * page only.
 */

export const HOLD_GUARD_MS = 300;

export type HoldSignal = "started" | "ended" | "cancelled";

type Key = Pick<KeyboardEvent, "code" | "type">;

export class HoldGestureTracker {
  private ctrl = false;
  private alt = false;
  /** Another key was involved: nothing happens until both keys are up again. */
  private spoiled = false;
  private holding = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly onSignal: (signal: HoldSignal) => void,
    private readonly timers: {
      set(fn: () => void, ms: number): ReturnType<typeof setTimeout>;
      clear(handle: ReturnType<typeof setTimeout> | undefined): void;
    } = { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h) },
  ) {}

  /** A keydown or keyup on the page. */
  key(event: Key): void {
    const down = event.type === "keydown";
    if (event.code === "ControlLeft") this.ctrl = down;
    else if (event.code === "AltLeft") this.alt = down;
    else if (down) {
      // Any other key (AltGr's right Alt included) spoils the gesture.
      if (this.ctrl || this.alt) this.spoil();
      return;
    } else return;

    if (this.ctrl && this.alt) {
      if (!this.spoiled && !this.holding && this.timer === undefined) {
        this.timer = this.timers.set(() => this.start(), HOLD_GUARD_MS);
      }
      return;
    }
    // One of the two came up.
    this.timers.clear(this.timer);
    this.timer = undefined;
    if (this.holding) {
      this.holding = false;
      this.onSignal("ended");
    }
    if (!this.ctrl && !this.alt) this.spoiled = false;
  }

  /** The page lost the keyboard (another window, a dialog): whatever was held is cancelled. */
  blur(): void {
    this.ctrl = false;
    this.alt = false;
    this.spoil();
    this.spoiled = false;
  }

  private start(): void {
    this.timer = undefined;
    if (this.spoiled || !this.ctrl || !this.alt) return;
    this.holding = true;
    this.onSignal("started");
  }

  private spoil(): void {
    this.spoiled = true;
    this.timers.clear(this.timer);
    this.timer = undefined;
    if (this.holding) {
      this.holding = false;
      this.onSignal("cancelled");
    }
  }
}
