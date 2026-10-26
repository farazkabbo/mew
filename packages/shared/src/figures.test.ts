import { describe, expect, it } from "vitest";

import { checkedStep } from "./circle";
import { GeometrySpec, Smiles } from "./figures";
import { ScreenAction, TutorScreenAction } from "./screen";
import { circleStepReasons } from "./screen-safety";
import { BoardAction } from "./tutor";

/** K5: figures the tutor describes and the device constructs (NOTEBOOKS_K §3.3). */

const anchor = { near: "free_space" } as const;
const box = { left: 200, top: 200, right: 600, bottom: 700 };

describe("figure schemas", () => {
  it("take a triangle by what is known, never by coordinates", () => {
    const spec = GeometrySpec.parse({
      kind: "triangle",
      given: { a: 3, b: 4 },
      rightAngleAt: "C",
      labels: { c: "hypotenuse" },
      show: ["right_angle_marker", "side_labels"],
      highlight: ["c"],
      points: [[0, 0]],
    });
    expect(spec).not.toHaveProperty("points");
    for (const bad of [
      { kind: "triangle", given: { a: -3 } },
      { kind: "triangle", given: { A: 180 } },
      { kind: "triangle", given: {}, rightAngleAt: "D" },
      { kind: "triangle", given: {}, labels: { a: "x".repeat(25) } },
      { kind: "polygon", sides: 2 },
      { kind: "polygon", sides: 13 },
      { kind: "angle", degrees: 360 },
      { kind: "coordinate_points", points: [] },
      { kind: "coordinate_points", points: [{ label: "P", x: 5000, y: 0 }] },
      { kind: "hexagon" },
    ]) {
      expect(GeometrySpec.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("take SMILES characters only, of a small molecule", () => {
    for (const ok of ["c1ccccc1", "CCO", "CC(=O)O", "[NH4+]", "C/C=C\\C", "N#N", "[O-]C(=O)C"]) {
      expect(Smiles.safeParse(ok).success, ok).toBe(true);
    }
    for (const bad of ["", "<b>", "CCO; rm", "C C", "x".repeat(201)]) {
      expect(Smiles.safeParse(bad).success, bad).toBe(false);
    }
    expect(
      BoardAction.safeParse({ type: "draw_molecule", smiles: "CCO", highlightAtoms: [60], anchor })
        .success,
    ).toBe(false);
  });
});

describe("sketches on screen", () => {
  const sketch = (figure: unknown, extra: object = {}) =>
    TutorScreenAction.parse({ type: "sketch", besideBox: box, figure, ...extra });

  it("hold the notebook's figures without a place, and nothing else", () => {
    expect(sketch({ type: "draw_molecule", smiles: "c1ccccc1" }).type).toBe("sketch");
    expect(sketch({ type: "draw_geometry", figure: { kind: "angle", degrees: 40 } }).type).toBe(
      "sketch",
    );
    for (const figure of [
      { type: "draw_plot", expressions: ["x"], xRange: [0, 1] },
      { type: "write_text", text: "hi" },
    ]) {
      expect(TutorScreenAction.safeParse({ type: "sketch", besideBox: box, figure }).success).toBe(
        false,
      );
    }
    expect(ScreenAction.safeParse({ type: "sketch", besideBox: box }).success).toBe(false);
  });

  it("are kept beside the marks, and their arrow must point into them", () => {
    const limits = { marks: box, widthPx: 1000, heightPx: 500 };
    const near = sketch({ type: "draw_molecule", smiles: "CCO" }, { pointTo: { x: 300, y: 300 } });
    const far = sketch({ type: "draw_molecule", smiles: "CCO" }, { pointTo: { x: 990, y: 990 } });
    const step = checkedStep({ actions: [near, far], say: "Here's ethanol." }, 0, limits);
    expect(step.actions).toEqual([near]);
  });

  it("have their labels safety-checked like any tutor text", () => {
    const step = {
      say: "Here's the molecule.",
      actions: [
        sketch({
          type: "draw_molecule",
          smiles: "CCO",
          atomLabels: [{ index: 0, text: "open regedit" }],
        }),
      ],
    };
    expect(circleStepReasons(step)).toContain("edit_registry");
  });
});
