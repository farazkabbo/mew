import type { Stroke } from "@mew/shared";

import { useNotebookUi } from "./store";

/**
 * Whether a stroke is drawn (and so can be erased or selected): hidden tutor ink can't, nor can
 * the steps of an explanation that's replaying and not drawn yet.
 */
export function isShown(stroke: Stroke): boolean {
  if (stroke.author !== "tutor") return true;
  const { showTutorInk, replayHidden } = useNotebookUi.getState();
  return showTutorInk && !(stroke.groupId && replayHidden.has(stroke.groupId));
}
