import type { Page } from "@mew/shared";

/** A blank page for a notebook node, at `index` among its pages. */
export function newPage(notebookId: string, index: number): Page {
  return {
    id: crypto.randomUUID(),
    notebookId,
    index,
    background: "dot_grid",
    createdAt: Date.now(),
  };
}
