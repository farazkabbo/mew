"use client";

import { useEffect, useRef } from "react";

import { HoldGestureTracker } from "./hold";

/**
 * Hold left Ctrl + left Alt on the notebook page to talk (K2): listening starts when the hold
 * does, and letting go asks Neb about what was said, like tapping the mascot. Holding never
 * types or clicks anything, and right Alt (AltGr) never counts.
 */
export function useHoldToTalk(handlers: { start(): void; release(): void }): void {
  const ref = useRef(handlers);
  useEffect(() => {
    ref.current = handlers;
  });

  useEffect(() => {
    const tracker = new HoldGestureTracker((signal) => {
      if (signal === "started") ref.current.start();
      else if (signal === "ended") ref.current.release();
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
