import type { Stroke } from "@mew/shared";

import { useNotebookUi } from "./store";

/**
 * Whether a stroke is drawn (and so can be erased or selected): hidden tutor ink can't, nor can
 * the steps of an explanation that's replaying and not drawn yet, nor a folded solution (K6).
 */
export function isShown(stroke: Stroke): boolean {
  if (stroke.author !== "tutor") return true;
  const { showTutorInk, replayHidden, foldedGroups } = useNotebookUi.getState();
  if (!showTutorInk || !stroke.groupId) return showTutorInk;
  return !replayHidden.has(stroke.groupId) && !foldedGroups.has(stroke.groupId);
}
