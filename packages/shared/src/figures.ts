import { z } from "zod";

/**
 * Figures the tutor draws to explain (K5, docs/NOTEBOOKS_K.md §3): in the notebook as ink beside
 * the work, on screen inside a sketch card. **The model describes; code constructs**: a figure
 * with rules (a triangle, a molecule) never carries coordinates. The solver and the SMILES layout
 * in `@mew/ink` build it, and refuse what can't exist.
 */
export const FIGURE_LIMITS = {
  labelChars: 24,
  /** Longest SMILES accepted (a small molecule a student would meet). */
  smilesChars: 200,
  /** Heavy atoms drawn at most; bigger molecules are too dense for a sketch. */
  atoms: 60,
  highlightAtoms: 12,
  atomLabels: 8,
  polygonSides: 12,
  points: 8,
  coordinate: 1000,
  /** Side lengths are in any unit; this only keeps them finite. */
  length: 100_000,
} as const;

const Label = z.string().trim().min(1).max(FIGURE_LIMITS.labelChars);
const Length = z.number().positive().max(FIGURE_LIMITS.length);
/** Degrees inside a triangle. */
const Degrees = z.number().gt(0).lt(180);

export const TriangleVertex = z.enum(["A", "B", "C"]);
export type TriangleVertex = z.infer<typeof TriangleVertex>;
export const TriangleSide = z.enum(["a", "b", "c"]);
export type TriangleSide = z.infer<typeof TriangleSide>;
const TrianglePart = z.enum(["a", "b", "c", "A", "B", "C"]);

/**
 * A triangle by what is known (side a is opposite vertex A, and so on): any consistent mix of
 * sides and angles in degrees. Missing lengths get a default size; impossible ones are refused.
 */
export const TriangleSpec = z.object({
  kind: z.literal("triangle"),
  given: z.object({
    a: Length.optional(),
    b: Length.optional(),
    c: Length.optional(),
    A: Degrees.optional(),
    B: Degrees.optional(),
    C: Degrees.optional(),
  }),
  rightAngleAt: TriangleVertex.optional(),
  /** Names to write instead of the defaults ("A", or a side's length when known). */
  labels: z
    .object({
      A: Label.optional(),
      B: Label.optional(),
      C: Label.optional(),
      a: Label.optional(),
      b: Label.optional(),
      c: Label.optional(),
    })
    .optional(),
  show: z
    .array(z.enum(["right_angle_marker", "angle_arcs", "side_labels", "height"]))
    .max(4)
    .optional(),
  highlight: z.array(TrianglePart).max(6).optional(),
});
export type TriangleSpec = z.infer<typeof TriangleSpec>;

export const CircleFigureSpec = z.object({
  kind: z.literal("circle"),
  show: z
    .array(z.enum(["radius", "diameter", "chord", "tangent"]))
    .max(4)
    .optional(),
  /** What to write by each part (e.g. radius "r = 5 cm"); the centre is "O" by default. */
  labels: z
    .object({
      centre: Label.optional(),
      radius: Label.optional(),
      diameter: Label.optional(),
      chord: Label.optional(),
      tangent: Label.optional(),
    })
    .optional(),
});

export const PolygonSpec = z.object({
  kind: z.literal("polygon"),
  sides: z.number().int().min(3).max(FIGURE_LIMITS.polygonSides),
  /** Always drawn regular (the brief's `regular: true`; a boolean so Gemini's schema takes it). */
  regular: z.boolean().optional(),
  /** Vertex names, in order round the shape. */
  labels: z.array(Label).max(FIGURE_LIMITS.polygonSides).optional(),
});

export const AngleSpec = z.object({
  kind: z.literal("angle"),
  degrees: z.number().gt(0).lt(360),
  label: Label.optional(),
});

const Coordinate = z.number().min(-FIGURE_LIMITS.coordinate).max(FIGURE_LIMITS.coordinate);

export const CoordinatePointsSpec = z.object({
  kind: z.literal("coordinate_points"),
  points: z
    .array(z.object({ label: Label, x: Coordinate, y: Coordinate }))
    .min(1)
    .max(FIGURE_LIMITS.points),
  /** Join the points in order (a path or, with 3 or more, a closed shape). */
  connect: z.boolean().optional(),
});

export const GeometrySpec = z.discriminatedUnion("kind", [
  TriangleSpec,
  CircleFigureSpec,
  PolygonSpec,
  AngleSpec,
  CoordinatePointsSpec,
]);
export type GeometrySpec = z.infer<typeof GeometrySpec>;

/**
 * SMILES, as written by a chemist: only its own characters (atoms, bonds, rings, branches,
 * charges). Parsing and layout happen on the device; an unparsable string draws nothing.
 */
export const Smiles = z
  .string()
  .trim()
  .min(1)
  .max(FIGURE_LIMITS.smilesChars)
  .regex(/^[A-Za-z0-9@+\-[\]()=#$:/\\.%]+$/, "not a SMILES string");

/** A molecule's drawing instructions, without where it goes. */
export const MoleculeFigure = z.object({
  smiles: Smiles,
  /** Aromatic rings as alternating double bonds (default) or a circle inside the ring. */
  aromaticStyle: z.enum(["kekule", "circle"]).optional(),
  /** Atoms to mark, by their 0-based order in the SMILES. */
  highlightAtoms: z
    .array(
      z
        .number()
        .int()
        .min(0)
        .max(FIGURE_LIMITS.atoms - 1),
    )
    .max(FIGURE_LIMITS.highlightAtoms)
    .optional(),
  atomLabels: z
    .array(
      z.object({
        index: z
          .number()
          .int()
          .min(0)
          .max(FIGURE_LIMITS.atoms - 1),
        text: Label,
      }),
    )
    .max(FIGURE_LIMITS.atomLabels)
    .optional(),
});
export type MoleculeFigure = z.infer<typeof MoleculeFigure>;

/** Every text a figure writes (for the safety check on tutor output). */
export function geometryTexts(figure: GeometrySpec): string[] {
  switch (figure.kind) {
    case "triangle":
      return Object.values(figure.labels ?? {}).filter((t): t is string => t !== undefined);
    case "circle":
      return Object.values(figure.labels ?? {}).filter((t): t is string => t !== undefined);
    case "polygon":
      return figure.labels ?? [];
    case "angle":
      return figure.label ? [figure.label] : [];
    case "coordinate_points":
      return figure.points.map((p) => p.label);
  }
}

export function moleculeTexts(figure: MoleculeFigure): string[] {
  return (figure.atomLabels ?? []).map((l) => l.text);
}
