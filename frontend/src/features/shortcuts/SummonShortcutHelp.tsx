"use client";

import { useEffect, useState, useSyncExternalStore } from "react";

import { isDesktop, macSummonShortcutStatus } from "../desktop/bridge";

const noSubscription = () => () => undefined;
export const MAC_SUMMON_LABEL = "Control + Shift + N";

export function isMacKeyboard(): boolean {
  return typeof navigator !== "undefined" && /Mac/.test(navigator.platform);
}

export function useMacKeyboard(): boolean {
  return useSyncExternalStore(noSubscription, isMacKeyboard, () => false);
}

/** Registration is native and may fail if another app owns the shortcut. */
export function SummonShortcutHelp() {
  const mac = useMacKeyboard();
  const [status, setStatus] = useState<boolean | null>();
  useEffect(() => {
    if (!mac) return;
    let current = true;
    void macSummonShortcutStatus().then((ready) => {
      if (current) setStatus(ready);
    });
    return () => {
      current = false;
    };
  }, [mac]);
  if (!mac)
    return (
      <>
        Hold <kbd>Ctrl+Alt</kbd> in a notebook, speak, then let go to ask.
      </>
    );
  if (!isDesktop()) return <>Tap the neb dot in your notebook to ask Neb.</>;
  if (status === undefined) return <>Checking the Mac shortcut…</>;
  if (status !== true)
    return (
      <>
        The Mac shortcut is unavailable. Use Ask Neb in the menu bar, or tap the neb dot in your
        notebook.
      </>
    );
  return (
    <>
      <kbd aria-label="Control Shift N">{MAC_SUMMON_LABEL}</kbd> (⌃⇧N): Open Neb from any app and
      ask in your notebook. Neb must be running. You can also tap the neb dot.
    </>
  );
}
