"use client";

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

/**
 * The notebook tree's shortcuts (K1, docs/NOTEBOOKS_K.md §11.3; two keys at most):
 * Alt+B new notebook (Ctrl+N too, in the desktop app only: browsers keep Ctrl+N), Alt+N new
 * chapter, Alt+P new page, F2 rename, Ctrl+K jump, Alt+↑/↓ move up or down.
 *
 * Alt shortcuts match the physical key (`code`), so they work on any layout and on a Mac (where
 * Option changes the character). Ctrl+Alt never counts: it's AltGr on many keyboards, used to
 * type "@" or "€". Nothing fires while typing in a field or while a dialog is open, and Alt+←/→
 * stay with the browser (back and forward).
 */
export function useTreeShortcuts(handlers: TreeShortcutHandlers, desktop: boolean): void {
  const ref = useRef(handlers);
  useEffect(() => {
    ref.current = handlers;
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const action = treeShortcut(event, desktop);
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
  }, [desktop]);
}

export type TreeShortcut = Exclude<keyof TreeShortcutHandlers, "reorder"> | "up" | "down";

/** The shortcut a key press means, if any. */
export function treeShortcut(
  event: Pick<KeyboardEvent, "key" | "code" | "altKey" | "ctrlKey" | "metaKey" | "shiftKey">,
  desktop: boolean,
): TreeShortcut | null {
  const { altKey, ctrlKey, metaKey, shiftKey } = event;
  if (shiftKey) return null;
  if (altKey && !ctrlKey && !metaKey) {
    const byCode: Record<string, TreeShortcut> = {
      KeyB: "newNotebook",
      KeyN: "newChapter",
      KeyP: "newPage",
      ArrowUp: "up",
      ArrowDown: "down",
    };
    return byCode[event.code] ?? null;
  }
  if ((ctrlKey || metaKey) && !altKey) {
    if (event.code === "KeyK") return "jump";
    if (event.code === "KeyN" && ctrlKey && desktop) return "newNotebook";
    return null;
  }
  if (!altKey && !ctrlKey && !metaKey && event.key === "F2") return "rename";
  return null;
}
