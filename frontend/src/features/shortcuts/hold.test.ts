import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HOLD_GUARD_MS, HoldGestureTracker, type HoldSignal } from "./hold";

describe("the Ctrl+Alt hold on the notebook page (K2)", () => {
  let signals: HoldSignal[];
  let hold: HoldGestureTracker;
  const down = (code: string) => hold.key({ code, type: "keydown" });
  const up = (code: string) => hold.key({ code, type: "keyup" });

  beforeEach(() => {
    vi.useFakeTimers();
    signals = [];
    hold = new HoldGestureTracker((s) => signals.push(s));
  });
  afterEach(() => vi.useRealTimers());

  it("starts after the guard and ends when a key comes up", () => {
    down("ControlLeft");
    down("AltLeft");
    vi.advanceTimersByTime(HOLD_GUARD_MS - 1);
    expect(signals).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(signals).toEqual(["started"]);
    up("AltLeft");
    expect(signals).toEqual(["started", "ended"]);
  });

  it("never starts for AltGr typing", () => {
    // AltGr on Windows: a left Ctrl and a right Alt arrive, then the key.
    down("ControlLeft");
    down("AltRight");
    down("KeyQ");
    vi.advanceTimersByTime(1000);
    up("KeyQ");
    up("AltRight");
    up("ControlLeft");
    expect(signals).toEqual([]);
  });

  it("is spoiled by a key within the guard, and cancelled by one after it", () => {
    down("ControlLeft");
    down("AltLeft");
    down("KeyE"); // Ctrl+Alt+E types "€" on some layouts
    vi.advanceTimersByTime(1000);
    expect(signals).toEqual([]);
    up("AltLeft");
    up("ControlLeft");
    // A fresh hold works again.
    down("AltLeft");
    down("ControlLeft");
    vi.advanceTimersByTime(HOLD_GUARD_MS);
    down("KeyX");
    expect(signals).toEqual(["started", "cancelled"]);
    up("ControlLeft");
    expect(signals).toEqual(["started", "cancelled"]);
  });

  it("cancels when the page loses the keyboard", () => {
    down("ControlLeft");
    down("AltLeft");
    vi.advanceTimersByTime(HOLD_GUARD_MS);
    hold.blur();
    expect(signals).toEqual(["started", "cancelled"]);
    vi.advanceTimersByTime(1000);
    expect(signals).toEqual(["started", "cancelled"]);
  });
});
