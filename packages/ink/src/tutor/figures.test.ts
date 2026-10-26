import {
  type BBox,
  BoardAction,
  GeometrySpec,
  type ScreenAction,
  ScreenAction as ScreenActionSchema,
  type Stroke,
} from "@mew/shared";
import { describe, expect, it } from "vitest";

import { bboxesIntersect } from "../geometry";
import { segmentLines } from "../segmentation";
import { strokeThrough, testId } from "../test-helpers";
import { ALL_RENDERERS } from "./actions";
import { type BoardInput, planBoard } from "./board";
import type { Figure } from "./figures/figure";
import { geometryFigure, triangleLayout } from "./figures/geometry";
import { kekulise, loadMolecule, type MoleculeLayout, moleculeFigure } from "./figures/molecule";
import { solveTriangle } from "./figures/triangle";
import { planScreenInk, prepareScreenInk, type ScreenInkInput } from "./screen/plan";
import { RoughPen } from "./visuals/rough";

/** K5: explaining by drawing (docs/NOTEBOOKS_K.md §3.3). */

const FRAME = { rect: [0, 0, 300, 220] as BBox, unit: 10 };
const frame = () => ({ ...FRAME, pen: new RoughPen(7) });

describe("solveTriangle", () => {
  it("solves a right triangle from its legs, the hypotenuse opposite the right angle", () => {
    const t = solveTriangle({ given: { a: 3, b: 4 }, rightAngleAt: "C" });
    if (typeof t === "string") throw new Error(t);
    expect(t.c).toBeCloseTo(5, 9);
    expect(t.C).toBeCloseTo(90, 9);
    expect(t.A + t.B).toBeCloseTo(90, 9);
    expect(t.right).toBe("C");
  });

  it("solves an obtuse triangle from two sides and the angle between them", () => {
    const t = solveTriangle({ given: { a: 5, b: 7, C: 120 } });
    if (typeof t === "string") throw new Error(t);
    expect(t.c).toBeCloseTo(Math.sqrt(25 + 49 + 35), 9);
    expect(t.C).toBeCloseTo(120, 9);
    expect(t.right).toBeNull();
  });

  it("uses the law of sines from a side and two angles", () => {
    const t = solveTriangle({ given: { a: 10, A: 30, B: 60 } });
    if (typeof t === "string") throw new Error(t);
    expect(t.C).toBeCloseTo(90, 9);
    expect(t.c).toBeCloseTo(20, 9);
    expect(t.b).toBeCloseTo(10 * Math.sqrt(3), 9);
  });

  it("solves from a leg and the hypotenuse (side-side-angle)", () => {
    const t = solveTriangle({ given: { a: 5, c: 13 }, rightAngleAt: "C" });
    if (typeof t === "string") throw new Error(t);
    expect(t.b).toBeCloseTo(12, 9);
  });

  it("gives a default size when no length is known", () => {
    const right = solveTriangle({ given: {}, rightAngleAt: "B" });
    if (typeof right === "string") throw new Error(right);
    expect([right.a, right.b, right.c].sort()).toEqual([3, 4, 5]);
    expect(right.b).toBe(5);
    const any = solveTriangle({ given: {} });
    expect(typeof any).toBe("object");
  });

  it.each([
    [{ given: { a: 1, b: 2, c: 5 } }, /triangle inequality/],
    [{ given: { a: 1, b: 2, c: 3 } }, /triangle inequality/],
    [{ given: { A: 90, B: 100 } }, /two angles/],
    [{ given: { A: 50, B: 60, C: 80 } }, /add up to 190/],
    [{ given: { A: 60 }, rightAngleAt: "A" as const }, /right angle/],
    [{ given: { a: 2, c: 1 }, rightAngleAt: "C" as const }, /too short/],
    [{ given: { a: 3, b: 4, c: 6 }, rightAngleAt: "C" as const }, /angle C would be/],
  ])("refuses an impossible triangle %#", (spec, reason) => {
    expect(solveTriangle(spec)).toMatch(reason);
  });
});

describe("geometry figures", () => {
  it("puts the right-angle square in the right angle's corner, as a real square", () => {
    for (const at of ["A", "B", "C"] as const) {
      const spec = GeometrySpec.parse({
        kind: "triangle",
        given: { a: 6, b: 8, c: 10 },
        rightAngleAt: at,
      });
      if (spec.kind !== "triangle") throw new Error("not a triangle");
      // 6-8-10 has its right angle at C; asking for it elsewhere is refused.
      const figure = geometryFigure(spec, frame());
      if (at !== "C") {
        expect(figure).toMatch(/angle/);
        continue;
      }
      if (typeof figure === "string") throw new Error(figure);
      const solved = solveTriangle(spec);
      if (typeof solved === "string") throw new Error(solved);
      const corner = vertexNear(figure, "C");
      const square = figure.paths.find((p) => p.length === 3 && isSquareCorner(p, corner));
      expect(square).toBeDefined();
    }
  });

  it("stands a right triangle on its longer leg with the right angle bottom left", () => {
    const solved = solveTriangle({ given: { a: 3, b: 4 }, rightAngleAt: "C" });
    if (typeof solved === "string") throw new Error(solved);
    const layout = triangleLayout(solved);
    expect(layout.C).toEqual([0, 0]);
    expect(layout.A).toEqual([4, 0]);
    expect(layout.B).toEqual([0, -3]);
  });

  it("draws an obtuse triangle inside its frame, with every vertex named", () => {
    const figure = geometryFigure({ kind: "triangle", given: { a: 5, b: 7, C: 120 } }, frame());
    if (typeof figure === "string") throw new Error(figure);
    expect(figure.labels.map((l) => l.text)).toEqual(
      expect.arrayContaining(["A", "B", "C", "5", "7"]),
    );
    for (const path of figure.paths) {
      for (const [x, y] of path) {
        expect(x).toBeGreaterThan(-5);
        expect(x).toBeLessThan(305);
        expect(y).toBeGreaterThan(-5);
        expect(y).toBeLessThan(225);
      }
    }
  });

  it("highlights the side asked for", () => {
    const figure = geometryFigure(
      {
        kind: "triangle",
        given: {},
        rightAngleAt: "C",
        highlight: ["c"],
        labels: { c: "hypotenuse" },
      },
      frame(),
    );
    if (typeof figure === "string") throw new Error(figure);
    expect(figure.accents).toHaveLength(1);
    expect(figure.labels.find((l) => l.text === "hypotenuse")?.accent).toBe(true);
  });

  it.each([
    { kind: "circle", show: ["radius", "diameter", "chord", "tangent"] },
    { kind: "polygon", sides: 6, regular: true, labels: ["A", "B", "C", "D", "E", "F"] },
    { kind: "angle", degrees: 135 },
    {
      kind: "coordinate_points",
      points: [
        { label: "P", x: 2, y: 3 },
        { label: "Q", x: -1, y: 1 },
      ],
      connect: true,
    },
  ])("draws a $kind", (raw) => {
    const figure = geometryFigure(GeometrySpec.parse(raw), frame());
    if (typeof figure === "string") throw new Error(figure);
    expect(figure.paths.length).toBeGreaterThan(0);
    expect(figure.labels.length).toBeGreaterThan(0);
  });
});

describe("molecules", () => {
  async function layout(smiles: string): Promise<MoleculeLayout> {
    const result = await loadMolecule(smiles);
    if (typeof result === "string") throw new Error(result);
    return result;
  }

  it("lays out benzene as a six-carbon ring with alternating double bonds", async () => {
    const benzene = await layout("c1ccccc1");
    expect(benzene.atoms.filter((a) => a?.element === "C")).toHaveLength(6);
    expect(benzene.bonds).toHaveLength(6);
    expect(benzene.aromaticRings).toHaveLength(1);
    const orders = kekulise(benzene);
    expect(orders && [...orders.values()].sort()).toEqual([1, 1, 1, 2, 2, 2]);
    // Kekulé: three single strokes, three doubles (two strokes each), no labels (skeletal).
    const kekule = moleculeFigure(benzene, {}, frame());
    if (typeof kekule === "string") throw new Error(kekule);
    expect(kekule.paths.length).toBeGreaterThanOrEqual(9);
    expect(kekule.labels).toEqual([]);
    const circle = moleculeFigure(benzene, { aromaticStyle: "circle" }, frame());
    if (typeof circle === "string") throw new Error(circle);
    expect(circle.paths.length).toBeLessThan(kekule.paths.length);
  });

  it("lays out cyclohexane as a ring of single bonds", async () => {
    const ring = await layout("C1CCCCC1");
    expect(ring.bonds.every((b) => b.order === 1 && !b.aromatic)).toBe(true);
    expect(ring.aromaticRings).toEqual([]);
    // Ring bonds are all about the same length.
    const lengths = ring.bonds.map((b) => {
      const p = ring.atoms[b.from]?.position ?? [0, 0];
      const q = ring.atoms[b.to]?.position ?? [0, 0];
      return Math.hypot(p[0] - q[0], p[1] - q[1]);
    });
    expect(Math.max(...lengths) - Math.min(...lengths)).toBeLessThan(1);
  });

  it("writes ethanol's OH with its hydrogen, and labels and highlights atoms by index", async () => {
    const ethanol = await layout("CCO");
    expect(ethanol.atoms.map((a) => a?.element)).toEqual(["C", "C", "O"]);
    const figure = moleculeFigure(
      ethanol,
      { highlightAtoms: [2], atomLabels: [{ index: 0, text: "methyl" }] },
      frame(),
    );
    if (typeof figure === "string") throw new Error(figure);
    expect(figure.labels.map((l) => l.text)).toEqual(expect.arrayContaining(["methyl"]));
    expect(figure.labels.some((l) => /^(OH|HO)$/.test(l.text))).toBe(true);
    expect(figure.accents).toHaveLength(1);
  });

  it("refuses an invalid SMILES (the tutor explains in words instead)", async () => {
    expect(await loadMolecule("C1CC(")).toMatch(/SMILES|read/);
  });

  it("refuses a molecule too big to sketch", async () => {
    expect(await loadMolecule("C".repeat(70))).toMatch(/too big/);
  });
});

describe("board actions", () => {
  const COLORS = { ink: "#8a7bf0", error: "#c8432b", correct: "#2f7d55", highlight: "#8a7bf055" };
  function input(): BoardInput {
    const strokes: Stroke[] = [
      strokeThrough(
        [
          [100, 124],
          [140, 100],
          [180, 124],
        ],
        { createdAt: 1, width: 3 },
      ),
    ];
    const lines = segmentLines(strokes);
    return {
      pageId: testId(),
      groupId: testId(),
      strokes,
      lines,
      activeLine: lines.at(-1),
      viewport: [0, 0, 1400, 1000],
      colors: COLORS,
      now: 1,
      newId: () => testId(),
    };
  }

  it("draws a triangle and a molecule beside the work, never over it", async () => {
    const page = input();
    const actions = [
      BoardAction.parse({
        type: "draw_geometry",
        figure: { kind: "triangle", given: { a: 3, b: 4 }, rightAngleAt: "C", highlight: ["c"] },
        anchor: { near: "free_space" },
      }),
      BoardAction.parse({
        type: "draw_molecule",
        smiles: "c1ccccc1",
        anchor: { near: "free_space" },
      }),
    ];
    const plan = await planBoard(actions, page, ALL_RENDERERS);
    expect(plan.skipped).toEqual([]);
    expect(plan.actions.map((a) => a.type)).toEqual(["draw_geometry", "draw_molecule"]);
    const student = page.strokes[0]?.bbox ?? [0, 0, 0, 0];
    for (const action of plan.actions) expect(bboxesIntersect(action.bbox, student)).toBe(false);
    const [first, second] = plan.actions;
    if (first && second) expect(bboxesIntersect(first.bbox, second.bbox)).toBe(false);
    // The hypotenuse is gone over in the tutor's highlighter.
    expect(
      first?.strokes.some((s) => s.tool === "highlighter" && s.color === COLORS.highlight),
    ).toBe(true);
  });

  it("skips an impossible triangle or an unreadable molecule with the reason", async () => {
    const plan = await planBoard(
      [
        BoardAction.parse({
          type: "draw_geometry",
          figure: { kind: "triangle", given: { a: 1, b: 1, c: 5 } },
          anchor: { near: "free_space" },
        }),
        BoardAction.parse({
          type: "draw_molecule",
          smiles: "C1CC((",
          anchor: { near: "free_space" },
        }),
      ],
      input(),
      ALL_RENDERERS,
    );
    expect(plan.actions).toEqual([]);
    expect(plan.skipped.map((s) => s.reason)).toEqual([
      expect.stringMatching(/triangle inequality/),
      expect.stringMatching(/SMILES|read/),
    ]);
  });

  it("refuses coordinates or unknown fields in a figure (the model describes, code builds)", () => {
    expect(
      BoardAction.safeParse({
        type: "draw_geometry",
        figure: { kind: "triangle", given: {}, points: [[0, 0]] },
        anchor: { near: "free_space" },
      }).success,
    ).toBe(true); // zod strips unknown keys…
    expect(
      BoardAction.parse({
        type: "draw_geometry",
        figure: { kind: "triangle", given: {}, points: [[0, 0]] },
        anchor: { near: "free_space" },
      }),
    ).not.toHaveProperty("figure.points"); // …so nothing but the spec reaches the solver.
    expect(
      BoardAction.safeParse({
        type: "draw_molecule",
        smiles: "<script>",
        anchor: { near: "free_space" },
      }).success,
    ).toBe(false);
  });
});

describe("the screen's sketch card", () => {
  const MONITOR: BBox = [0, 0, 2880, 1620];
  const input = (): ScreenInkInput => ({
    frame: MONITOR,
    bounds: MONITOR,
    obstacles: [],
    textHeight: 24,
    scale: 1.5,
    seed: "turn-1",
    colors: { ink: "#8a7bf0", highlight: "#8a7bf055" },
  });
  const marked = { left: 300, top: 300, right: 450, bottom: 400 };

  it("draws a figure on a card beside the marks, off them, with an arrow into them", async () => {
    const actions: ScreenAction[] = [
      ScreenActionSchema.parse({
        type: "sketch",
        besideBox: marked,
        figure: { type: "draw_molecule", smiles: "c1ccccc1" },
        pointTo: { x: 375, y: 350 },
      }),
      ScreenActionSchema.parse({
        type: "sketch",
        besideBox: marked,
        figure: {
          type: "draw_geometry",
          figure: { kind: "triangle", given: {}, rightAngleAt: "C" },
        },
      }),
    ];
    await prepareScreenInk(actions);
    const plan = planScreenInk(actions, input());
    expect(plan.skipped).toEqual([]);
    const [ring, triangle] = plan.actions;
    const marks: BBox = [864, 486, 432, 162];
    for (const sketch of [ring, triangle]) {
      expect(sketch?.card).toBeDefined();
      const card = sketch?.card ?? [0, 0, 0, 0];
      expect(card[2]).toBeCloseTo(480);
      expect(card[3]).toBeCloseTo(360);
      expect(bboxesIntersect(card, marks)).toBe(false);
    }
    // The second card doesn't cover the first.
    expect(bboxesIntersect(ring?.card ?? [0, 0, 0, 0], triangle?.card ?? [0, 0, 0, 0])).toBe(false);
    // The arrow reaches into the marked area.
    const reaches = ring?.strokes.some((s) =>
      s.points.some(([x, y]) => x > 864 && x < 1296 && y > 486 && y < 648),
    );
    expect(reaches).toBe(true);
  });

  it("skips a molecule that wasn't loaded first, and an invalid one", async () => {
    const unloaded = ScreenActionSchema.parse({
      type: "sketch",
      besideBox: marked,
      figure: { type: "draw_molecule", smiles: "CCCCO" },
    });
    expect(planScreenInk([unloaded], input()).skipped[0]?.reason).toMatch(/loaded/);
    const invalid = ScreenActionSchema.parse({
      type: "sketch",
      besideBox: marked,
      figure: { type: "draw_molecule", smiles: "C1CC((" },
    });
    await prepareScreenInk([invalid]);
    expect(planScreenInk([invalid], input()).skipped[0]?.reason).toMatch(/SMILES|read/);
  });
});

function vertexNear(figure: Figure, name: string): [number, number] {
  const label = figure.labels.find((l) => l.text === name);
  if (!label) throw new Error(`no label ${name}`);
  // The vertex is the path point nearest its label.
  let best: [number, number] = [0, 0];
  let distance = Infinity;
  for (const path of figure.paths) {
    for (const p of path) {
      const d = Math.hypot(p[0] - label.at[0], p[1] - label.at[1]);
      if (d < distance) {
        distance = d;
        best = [p[0], p[1]];
      }
    }
  }
  return best;
}

/** A three-point path a, b, c whose ends sit near `corner` and that turns 90° twice. */
function isSquareCorner(path: [number, number][], corner: [number, number]): boolean {
  const [a, b, c] = path as [[number, number], [number, number], [number, number]];
  const near = (p: [number, number]) => Math.hypot(p[0] - corner[0], p[1] - corner[1]) < 20;
  const ab: [number, number] = [b[0] - a[0], b[1] - a[1]];
  const cb: [number, number] = [b[0] - c[0], b[1] - c[1]];
  const square =
    Math.abs(ab[0] * cb[0] + ab[1] * cb[1]) < 1e-6 &&
    Math.abs(Math.hypot(...ab) - Math.hypot(...cb)) < 1e-6;
  return near(a) && near(c) && square;
}
