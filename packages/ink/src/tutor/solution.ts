import type { Anchor, BBox } from "@mew/shared";

import { inflateBBox } from "../geometry";
import { type BoardInput, type BoardPlan, BoardPlanner, type PlannedAction } from "./board";
import { type Box, hbox } from "./typeset/box";
import { RoughPen } from "./visuals/rough";

/**
 * Show-then-You's own ink (K6 §6.1): the final answer in a box, and the "Your turn" box with room
 * to write under the problem. Planned like board actions (placed in free space, never over the
 * student's work) but made by code, not asked for by the model.
 */

type Content = { text: string; latex: string | null };

const below: Anchor = { near: "below_active_line" };

function typeset(planner: BoardPlanner, content: Content): Box {
  if (content.latex) {
    const math = planner.typesetMath(content.latex);
    if (math.marks.length > 0) return math;
  }
  return planner.typesetText(content.text);
}

function plan(planner: BoardPlanner, actions: PlannedAction[]): BoardPlan {
  return {
    actions,
    skipped: [],
    scale: planner.scale,
    missing: planner.missingCharacters(),
  };
}

/** The final answer, written below the working and boxed. */
export function planBoxedAnswer(content: Content, input: BoardInput): BoardPlan {
  const planner = new BoardPlanner(input);
  const box = typeset(planner, content);
  const x = planner.scale.xHeight;
  const pad = 0.6;
  // Room for the box round it: placed as one, so the box never touches other ink.
  const frame: Box = {
    width: box.width + 2 * pad,
    ascent: box.ascent + pad,
    descent: box.descent + pad,
    marks: [],
  };
  const rect = planner.place(frame, below);
  const at: [number, number] = [rect[0] + pad * x, rect[1] + (box.ascent + pad) * x];
  const pen = new RoughPen(planner.seed(), 0.6);
  const planned = planner.commit(
    {
      color: planner.input.colors.ink,
      pieces: [{ box, at }],
      paths: pen.rectangle(rect[0], rect[1], rect[2], rect[3]),
    },
    "write_math",
    0,
  );
  return plan(planner, planned ? [planned] : []);
}

export type YourTurnPlan = BoardPlan & {
  /** Where the student writes their answer: inside the box, under the problem. */
  region: BBox | null;
};

/** How wide the box is and how many lines of room it leaves, in x-heights and lines. */
const BOX_WIDTH = 30;
const WRITING_LINES = 5;
const LINE_HEIGHT = 2.6;

/** "Your turn:" and the problem at the top of a box, with room for about five lines under it. */
export function planYourTurn(content: Content, input: BoardInput): YourTurnPlan {
  const planner = new BoardPlanner(input);
  const x = planner.scale.xHeight;
  const header = planner.typesetText("Your turn:", 0.9);
  const problem = typeset(planner, content);
  // "Your turn: 5x − 4 = 21" on one line, as the student would read it.
  const top = hbox([header, problem], 0.8);
  const pad = 0.8;
  const writing = WRITING_LINES * LINE_HEIGHT;
  const width = Math.max(BOX_WIDTH, top.width + 2 * pad);
  const frame: Box = {
    width,
    ascent: pad + top.ascent + top.descent + writing + pad,
    descent: 0,
    marks: [],
  };
  const rect = planner.place(frame, below);
  const pen = new RoughPen(planner.seed(), 0.6);
  const planned = planner.commit(
    {
      color: planner.input.colors.ink,
      pieces: [{ box: top, at: [rect[0] + pad * x, rect[1] + (pad + top.ascent) * x] }],
      paths: pen.rectangle(rect[0], rect[1], rect[2], rect[3]),
    },
    "write_text",
    0,
  );
  if (!planned) return { ...plan(planner, []), region: null };
  const textBottom = rect[1] + (pad + top.ascent + top.descent) * x;
  const region: BBox = inflateBBox(
    [rect[0], textBottom, rect[2], rect[1] + rect[3] - textBottom],
    -0.2 * x,
  );
  return { ...plan(planner, [planned]), region };
}
