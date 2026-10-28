"use client";

import {
  bindingOfKey,
  FIXED_KEYS,
  type ShortcutBindings,
  type ShortcutPlatform,
  shortcutFor,
} from "@mew/shared";
import { useEffect, useRef } from "react";

import { isTypingTarget } from "./dom";
import { useNotebookUi } from "./store";

type Handlers = {
  undo(): void;
  redo(): void;
  zoom(factor: number): void;
  resetView(): void;
  /** Alt+C: check my work (K2 §11.3). */
  checkWork(): void;
  /** Shift+? (or "?"): the shortcuts sheet (NEB_APP_UI §5.6). */
  showShortcuts?(): void;
};

/**
 * Notebook keyboard shortcuts (two keys at most, K2), with the student's own bindings: undo and
 * redo (Ctrl+Z, Ctrl+Y), check my work (Alt+C), the tools (P, E, H, L), and the fixed single keys
 * (T tutor ink, + − 0 zoom). Ignored while typing in form fields or while a dialog is open. The
 * tree's shortcuts are `useTreeShortcuts`'.
 */
export function useShortcuts(
  handlers: Handlers,
  platform: ShortcutPlatform,
  own: ShortcutBindings,
): void {
  const ref = useRef(handlers);
  useEffect(() => {
    ref.current = handlers;
  });

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target) || document.querySelector("dialog[open]")) return;
      const h = ref.current;
      const ui = useNotebookUi.getState();
      const action = shortcutFor(e, platform, own);

      let handled = true;
      if (action === "undo") h.undo();
      else if (action === "redo") h.redo();
      else if (action === "check_work") {
        if (!e.repeat) h.checkWork();
      } else if (action === "pen") ui.setTool("pen");
      else if (action === "highlighter") ui.setTool("highlighter");
      else if (action === "eraser") ui.setTool("eraser");
      else if (action === "lasso") ui.setTool("lasso");
      else if (e.key === "?" && !e.ctrlKey && !e.altKey && !e.metaKey && h.showShortcuts) {
        h.showShortcuts();
      } else if (zoomCharacter(e)) h.zoom(e.key === "+" ? 1.25 : 1 / 1.25);
      else handled = fixedKey(bindingOfKey(e), h, ui.toggleTutorInk);

      if (handled) e.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [platform, own]);
}

/** "+" or "-" typed as a character (Shift+= on many layouts, or the number pad): zoom. */
function zoomCharacter(e: KeyboardEvent): boolean {
  return (e.key === "+" || e.key === "-") && !e.ctrlKey && !e.altKey && !e.metaKey;
}

/** The notebook's own single keys (not rebindable). True if `binding` was one. */
function fixedKey(binding: string | null, h: Handlers, toggleTutorInk: () => void): boolean {
  if (!binding || !(binding in FIXED_KEYS)) return false;
  if (binding === "T") toggleTutorInk();
  else if (binding === "Equal") h.zoom(1.25);
  else if (binding === "Minus") h.zoom(1 / 1.25);
  else h.resetView();
  return true;
}
