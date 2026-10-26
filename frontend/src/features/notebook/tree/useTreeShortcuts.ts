"use client";

import {
  type KeyPress,
  type ShortcutAction,
  type ShortcutBindings,
  type ShortcutPlatform,
  shortcutFor,
} from "@mew/shared";
import { useEffect, useRef } from "react";

import { isTypingTarget } from "../dom";

export type TreeShortcutHandlers = {
  newNotebook(): void;
  newChapter(): void;
  newPage(): void;
  rename(): void;
  jump(): void;
  reorder(step: -1 | 1): void;
};

export type TreeShortcut = Exclude<keyof TreeShortcutHandlers, "reorder"> | "up" | "down";

const TREE_ACTIONS: Partial<Record<ShortcutAction, TreeShortcut>> = {
  new_notebook: "newNotebook",
  new_chapter: "newChapter",
  new_page: "newPage",
  rename: "rename",
  jump: "jump",
  move_up: "up",
  move_down: "down",
};

/**
 * The notebook tree's shortcuts (K1, K2; docs/NOTEBOOKS_K.md §11.3; two keys at most), with the
 * student's own bindings from Settings → Shortcuts: by default Alt+B new notebook (Ctrl+N too, in
 * the desktop app only: browsers keep Ctrl+N), Alt+N new chapter, Alt+P new page, F2 rename,
 * Ctrl+K jump, Alt+↑/↓ move up or down.
 *
 * Shortcuts match the physical key (`code`), so they work on any layout and on a Mac (where
 * Option changes the character). Ctrl+Alt never counts: it's AltGr on many keyboards, used to
 * type "@" or "€". Nothing fires while typing in a field (except the jump palette) or while a
 * dialog is open, and Alt+←/→ stay with the browser (back and forward).
 */
export function useTreeShortcuts(
  handlers: TreeShortcutHandlers,
  platform: ShortcutPlatform,
  own: ShortcutBindings,
): void {
  const ref = useRef(handlers);
  useEffect(() => {
    ref.current = handlers;
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const action = treeShortcut(event, platform, own);
      if (!action) return;
      if (document.querySelector("dialog[open]")) return;
      if (action !== "jump" && isTypingTarget(event.target)) return;
      event.preventDefault();
      if (event.repeat && action !== "up" && action !== "down") return;
      const h = ref.current;
      if (action === "up" || action === "down") h.reorder(action === "up" ? -1 : 1);
      else h[action]();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [platform, own]);
}

/** The tree shortcut a key press means, if any. */
export function treeShortcut(
  event: KeyPress,
  platform: ShortcutPlatform,
  own: ShortcutBindings = {},
): TreeShortcut | null {
  const action = shortcutFor(event, platform, own);
  return (action && TREE_ACTIONS[action]) ?? null;
}
