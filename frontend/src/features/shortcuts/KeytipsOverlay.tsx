"use client";

import { useEffect, useState } from "react";

import { Keys } from "@/components/ui/Keycap";

/** Hold Alt this long, alone, for the keys to show (NEB_APP_UI §5.6). */
export const KEYTIP_HOLD_MS = 400;

type Tip = { keys: string; x: number; y: number };

/** How far a badge's centre stays from the window's edge (about half a two-key badge). */
const EDGE = 44;

/**
 * Keytips (docs/NEB_APP_UI.md §5.6, board 6): hold Alt for 400 ms anywhere in neb and every
 * control with a shortcut (`data-keytip="Alt+C"`) shows its keys at its top-right; let go and
 * they disappear. Alt pressed with another key is a shortcut, not this. Alt let go after showing
 * the tips doesn't move focus to the browser's menu.
 */
export function KeytipsOverlay() {
  const [tips, setTips] = useState<Tip[] | null>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let shown = false;
    const cancel = () => {
      if (timer) clearTimeout(timer);
      timer = null;
    };
    const hide = () => {
      cancel();
      shown = false;
      setTips(null);
    };
    const down = (event: KeyboardEvent) => {
      if (event.key !== "Alt") {
        hide(); // a shortcut (Alt+C), not a look at the keys
        return;
      }
      if (event.repeat || timer || shown) return;
      if (event.ctrlKey || event.shiftKey || event.metaKey) return;
      timer = setTimeout(() => {
        timer = null;
        shown = true;
        setTips(collect());
      }, KEYTIP_HOLD_MS);
    };
    const up = (event: KeyboardEvent) => {
      if (event.key !== "Alt") return;
      if (shown) event.preventDefault(); // no focus jump to the menu bar
      hide();
    };
    window.addEventListener("keydown", down, true);
    window.addEventListener("keyup", up, true);
    window.addEventListener("blur", hide);
    return () => {
      cancel();
      window.removeEventListener("keydown", down, true);
      window.removeEventListener("keyup", up, true);
      window.removeEventListener("blur", hide);
    };
  }, []);

  if (!tips) return null;
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 z-[70]" data-testid="keytips">
      {tips.map((tip, i) => (
        <span
          key={i}
          className="absolute -translate-x-1/2 -translate-y-1/2 rounded-[7px] bg-paper-hi p-0.5 shadow-sh-2"
          style={{ left: tip.x, top: tip.y }}
        >
          <Keys keys={tip.keys.split("+")} size="sm" />
        </span>
      ))}
    </div>
  );
}

/** Every visible control that has a shortcut, and where its badge goes. */
function collect(): Tip[] {
  return [...document.querySelectorAll<HTMLElement>("[data-keytip]")]
    .map((element) => ({ element, box: element.getBoundingClientRect() }))
    .filter(({ box }) => box.width > 0 && box.height > 0 && box.bottom > 0 && box.top < innerHeight)
    .map(({ element, box }) => ({
      keys: element.dataset.keytip ?? "",
      // Kept inside the window (a control at the edge still shows its keys whole).
      x: Math.min(box.right - 4, innerWidth - EDGE),
      y: Math.max(box.top + 4, EDGE / 2),
    }))
    .filter((tip) => tip.keys);
}
