import type { Stroke } from "@mew/shared";

import { useNotebookUi } from "./store";

/** Whether a stroke is drawn (and so can be erased or selected): hidden tutor ink can't. */
export function isShown(stroke: Stroke): boolean {
  return stroke.author !== "tutor" || useNotebookUi.getState().showTutorInk;
}
