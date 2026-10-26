import type { BoardAction } from "@mew/shared";

import { unionBBox } from "../../geometry";
import type { ActionRenderer, BoardPlanner, PlannedAction } from "../board";
import type { Figure } from "../figures/figure";
import { geometryFigure } from "../figures/geometry";
import { loadMolecule, moleculeFigure } from "../figures/molecule";
import type { Box } from "../typeset/box";
import { RoughPen } from "./rough";

type Of<T extends BoardAction["type"]> = Extract<BoardAction, { type: T }>;

/** The area a figure takes, in x-heights of the visual size (like sketches: brief §3.3). */
const AREA = { width: 20, height: 15 };

/**
 * Geometry (K5): solved in code and drawn by hand beside the work. A figure that can't exist is
 * skipped with the solver's reason, and the tutor's words carry the explanation.
 */
export const drawGeometry: ActionRenderer<Of<"draw_geometry">> = (action, planner, index) => {
  const frame = reserve(planner, action.anchor);
  const figure = geometryFigure(action.figure, {
    rect: frame,
    unit: planner.visualSize,
    pen: new RoughPen(planner.seed()),
  });
  return typeof figure === "string" ? figure : inkFigure(figure, planner, action.type, index);
};

/** A molecule from SMILES (K5): laid out by smiles-drawer, drawn as our own strokes. */
export const drawMolecule: ActionRenderer<Of<"draw_molecule">> = async (action, planner, index) => {
  const layout = await loadMolecule(action.smiles);
  if (typeof layout === "string") return layout;
  const frame = reserve(planner, action.anchor);
  const figure = moleculeFigure(layout, action, {
    rect: frame,
    unit: planner.visualSize,
    pen: new RoughPen(planner.seed()),
  });
  return typeof figure === "string" ? figure : inkFigure(figure, planner, action.type, index);
};

function reserve(planner: BoardPlanner, anchor: Of<"draw_geometry">["anchor"]) {
  const k = planner.visualFactor;
  const box: Box = { width: AREA.width * k, ascent: AREA.height * k, descent: 0, marks: [] };
  return planner.place(box, anchor);
}

/** Paths first, then the labels centred on their spots, then the highlighter over the parts. */
function inkFigure(
  figure: Figure,
  planner: BoardPlanner,
  type: BoardAction["type"],
  index: number,
): PlannedAction | string {
  const x = planner.scale.xHeight;
  const k = planner.visualFactor;
  const pieces = figure.labels.map((label) => {
    const box = planner.typesetText(label.text, label.scale * k);
    const at: [number, number] = [
      label.at[0] - (box.width * x) / 2,
      label.at[1] + ((box.ascent - box.descent) * x) / 2,
    ];
    return { box, at };
  });
  const { colors } = planner.input;
  const drawn = planner.commit({ color: colors.ink, pieces, paths: figure.paths }, type, index);
  if (!drawn) return "too much ink";
  if (figure.accents.length === 0) return drawn;
  const accents = planner.commit(
    {
      color: colors.highlight ?? colors.ink,
      pieces: [],
      paths: figure.accents,
      tool: "highlighter",
      width: 0.9 * planner.visualSize,
    },
    type,
    index,
  );
  if (!accents) return drawn;
  return {
    ...drawn,
    strokes: [...drawn.strokes, ...accents.strokes],
    bbox: unionBBox(drawn.bbox, accents.bbox),
  };
}
