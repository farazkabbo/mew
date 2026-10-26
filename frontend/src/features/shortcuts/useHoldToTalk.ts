"use client";

import { useEffect, useRef } from "react";

import { HoldGestureTracker } from "./hold";

type HoldHandlers = {
  start(): void;
  /** Let go: `heldAt` is when the hold started (words since then were said during it). */
  release(heldAt: number): void;
  /** Another key came in, or the page lost the keyboard: nothing is asked. */
  cancel?(): void;
};

/**
 * Hold left Ctrl + left Alt on the notebook page to talk and circle (K2, K6 §6.3): listening
 * starts when the hold does, and letting go asks Neb about what was said and circled. Holding
 * never types or clicks anything, and right Alt (AltGr) never counts.
 */
export function useHoldToTalk(handlers: HoldHandlers): void {
  const ref = useRef(handlers);
  useEffect(() => {
    ref.current = handlers;
  });

  useEffect(() => {
    let heldAt = 0;
    const tracker = new HoldGestureTracker((signal) => {
      if (signal === "started") {
        heldAt = Date.now();
        ref.current.start();
      } else if (signal === "ended") ref.current.release(heldAt);
      else ref.current.cancel?.();
    });
    const onKey = (event: KeyboardEvent) => tracker.key(event);
    const onBlur = () => tracker.blur();
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKey);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKey);
      window.removeEventListener("blur", onBlur);
      tracker.blur();
    };
  }, []);
}
