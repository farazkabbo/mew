"use client";

import { useEffect, useRef } from "react";

import { useNotebookUi } from "./store";

type Handlers = {
  undo(): void;
  redo(): void;
  zoom(factor: number): void;
  resetView(): void;
};

/** Notebook keyboard shortcuts. Ignored while typing in form fields. */
export function useShortcuts(handlers: Handlers): void {
  const ref = useRef(handlers);
  useEffect(() => {
    ref.current = handlers;
  });

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target) || e.altKey) return;
      const h = ref.current;
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      const ui = useNotebookUi.getState();

      let handled = true;
      if (mod && key === "z") {
        if (e.shiftKey) h.redo();
        else h.undo();
      } else if (mod && key === "y") h.redo();
      else if (mod) handled = false;
      else if (key === "p") ui.setTool("pen");
      else if (key === "h") ui.setTool("highlighter");
      else if (key === "e") ui.setTool("eraser");
      else if (key === "+" || key === "=") h.zoom(1.25);
      else if (key === "-") h.zoom(1 / 1.25);
      else if (key === "0") h.resetView();
      else handled = false;

      if (handled) e.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}

function isTypingTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
  );
}
