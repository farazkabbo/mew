"use client";

import {
  ariaKeyshortcuts,
  bindingsFor,
  formatBinding,
  type ShortcutAction,
  type ShortcutBindings,
  type ShortcutPlatform,
} from "@mew/shared";
import { useSyncExternalStore } from "react";

import { isDesktop } from "../desktop/bridge";
import { useSettings } from "../settings/store";

const noSubscription = () => () => undefined;

/** The browser, or the desktop app's window (which may take Ctrl+N). */
export function useShortcutPlatform(): ShortcutPlatform {
  return useSyncExternalStore(
    noSubscription,
    () => (isDesktop() ? "desktop" : "browser"),
    () => "browser",
  );
}

export type ShortcutKeys = {
  platform: ShortcutPlatform;
  own: ShortcutBindings;
  /** How an action's (first) binding is shown: "Alt+B", "Ctrl+K", "F2". */
  shown(action: ShortcutAction): string;
  /** Its `aria-keyshortcuts` value. */
  aria(action: ShortcutAction): string;
};

/** The notebook's shortcuts right now: the platform's defaults and the student's own (K2). */
export function useShortcutKeys(): ShortcutKeys {
  const platform = useShortcutPlatform();
  const own = useSettings((s) => s.settings.shortcuts);
  const first = (action: ShortcutAction) => bindingsFor(action, platform, own)[0] ?? "";
  return {
    platform,
    own,
    shown: (action) => formatBinding(first(action)),
    aria: (action) => ariaKeyshortcuts(first(action)),
  };
}
