import type { Stroke } from "@mew/shared";

import { useNotebookUi } from "./store";

/**
 * Whether a stroke is drawn (and so can be erased or selected): hidden tutor ink can't, nor can
 * the steps of an explanation that's replaying and not drawn yet, nor a folded solution (K6).
 */
export function isShown(stroke: Stroke): boolean {
  const {
    showTutorInk,
    replayHidden,
    foldedGroups,
    marksHiddenOn,
    unrevealedMarks,
    pageReplayHidden,
  } = useNotebookUi.getState();
  // K9 page Replay: what hasn't been drawn again yet, the student's ink too.
  if (pageReplayHidden?.has(stroke.id)) return false;
  if (stroke.author !== "tutor") return true;
  // K9: the page's marks layer can be hidden (its eye), and hide-until-done holds marks back.
  if (
    stroke.markKind &&
    (marksHiddenOn.has(stroke.pageId) || unrevealedMarks.has(stroke.groupId ?? ""))
  )
    return false;
  if (!showTutorInk || !stroke.groupId) return showTutorInk;
  return !replayHidden.has(stroke.groupId) && !foldedGroups.has(stroke.groupId);
}

/**
 * Whether the eraser and lasso may take a stroke: anything shown except live annotations' marks
 * (K9 §7.3: they're removed by tapping them, never with the student's tools).
 */
export function isEditable(stroke: Stroke): boolean {
  return stroke.markKind === undefined && isShown(stroke);
}
