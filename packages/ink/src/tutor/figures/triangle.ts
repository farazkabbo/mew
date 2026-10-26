import type { TriangleSpec, TriangleVertex } from "@mew/shared";

/**
 * Solves a triangle from what the model said is known (K5, NOTEBOOKS_K §3.3): the law of sines
 * and cosines, a default size when no length is given, and a refusal (a reason string) when the
 * figure can't exist. Side a is opposite vertex A, b opposite B, c opposite C; angles in degrees.
 */
export type SolvedTriangle = {
  a: number;
  b: number;
  c: number;
  A: number;
  B: number;
  C: number;
  /** The vertex with the 90° angle, if any. */
  right: TriangleVertex | null;
};

/** Angles within this many degrees of each other are equal (the model rounds). */
const ANGLE_TOLERANCE = 0.75;
/** Relative tolerance for lengths that are over-determined (all three sides plus an angle). */
const LENGTH_TOLERANCE = 0.02;

const VERTICES = ["A", "B", "C"] as const;
const SIDE_OF = { A: "a", B: "b", C: "c" } as const;
const rad = (deg: number) => (deg * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

type Given = {
  a?: number | undefined;
  b?: number | undefined;
  c?: number | undefined;
  A?: number | undefined;
  B?: number | undefined;
  C?: number | undefined;
};

export function solveTriangle(
  spec: Pick<TriangleSpec, "given" | "rightAngleAt">,
): SolvedTriangle | string {
  const given: Given = { ...spec.given };
  if (spec.rightAngleAt) {
    const at = given[spec.rightAngleAt];
    if (at !== undefined && Math.abs(at - 90) > ANGLE_TOLERANCE) {
      return `angle ${spec.rightAngleAt} can't be both ${at}° and a right angle`;
    }
    given[spec.rightAngleAt] = 90;
  }

  const angles = VERTICES.filter((v) => given[v] !== undefined);
  const sum = angles.reduce((n, v) => n + (given[v] ?? 0), 0);
  if (angles.length === 3 && Math.abs(sum - 180) > ANGLE_TOLERANCE) {
    return `the angles add up to ${round(sum)}°, not 180°`;
  }
  if (angles.length === 2) {
    if (sum >= 180 - ANGLE_TOLERANCE) return `two angles already make ${round(sum)}°`;
    const missing = VERTICES.find((v) => given[v] === undefined);
    if (missing) given[missing] = 180 - sum;
  }

  const solved = solve(given);
  if (typeof solved === "string") return solved;
  // Whatever was given (the right angle too) must still hold: an over-determined spec can
  // disagree with itself.
  for (const v of VERTICES) {
    const want = given[v];
    if (want !== undefined && Math.abs(want - solved[v]) > ANGLE_TOLERANCE) {
      return `angle ${v} would be ${round(solved[v])}°, not ${want}°`;
    }
  }
  const scale = lengthScale(spec.given, solved);
  if (typeof scale === "string") return scale;
  const result = {
    a: solved.a * scale,
    b: solved.b * scale,
    c: solved.c * scale,
    A: solved.A,
    B: solved.B,
    C: solved.C,
  };
  const right = VERTICES.find((v) => Math.abs(result[v] - 90) <= ANGLE_TOLERANCE) ?? null;
  return { ...result, right };
}

type Full = { a: number; b: number; c: number; A: number; B: number; C: number };

/** Every side and angle, from a set of knowns already checked for the angle sum. */
function solve(g: Given): Full | string {
  const sides = (["a", "b", "c"] as const).filter((s) => g[s] !== undefined);
  const angles = VERTICES.filter((v) => g[v] !== undefined);

  if (sides.length === 3) {
    const [a = 0, b = 0, c = 0] = [g.a, g.b, g.c];
    const [p, q, r] = [a, b, c].sort((x, y) => x - y) as [number, number, number];
    if (p + q <= r * (1 + 1e-9)) {
      return `sides ${fmt(p)}, ${fmt(q)} and ${fmt(r)} break the triangle inequality`;
    }
    return fromSides(a, b, c);
  }

  if (angles.length === 3) {
    const [A = 60, B = 60, C = 60] = [g.A, g.B, g.C];
    // Known side → law of sines; none → a default size (the longest side 1).
    const known = sides[0];
    const ratio = known
      ? (g[known] ?? 1) / Math.sin(rad(g[upper(known)] ?? 60))
      : 1 / Math.max(Math.sin(rad(A)), Math.sin(rad(B)), Math.sin(rad(C)));
    return {
      a: ratio * Math.sin(rad(A)),
      b: ratio * Math.sin(rad(B)),
      c: ratio * Math.sin(rad(C)),
      A,
      B,
      C,
    };
  }

  if (sides.length === 2) {
    const [s1, s2] = sides as [Side, Side];
    const third = (["a", "b", "c"] as const).find((s) => !sides.includes(s)) ?? "c";
    const between = upper(third);
    const x = g[s1] ?? 1;
    const y = g[s2] ?? 1;
    // Side-angle-side: the angle between the two known sides (opposite the third side).
    const included = g[between];
    if (included !== undefined) {
      const z = Math.sqrt(x * x + y * y - 2 * x * y * Math.cos(rad(included)));
      return fromSides(...ordered({ [s1]: x, [s2]: y, [third]: z }));
    }
    // Side-side-angle: an angle opposite one of the known sides.
    const opposite = angles.find((v) => v === upper(s1) || v === upper(s2));
    if (opposite) {
      const facing = SIDE_OF[opposite];
      const other = facing === s1 ? s2 : s1;
      const known = g[facing] ?? 1;
      const otherLength = g[other] ?? 1;
      const sinOther = (otherLength * Math.sin(rad(g[opposite] ?? 0))) / known;
      if (sinOther > 1 + 1e-9) {
        return `side ${facing} is too short to reach side ${other} at that angle`;
      }
      // Two triangles may fit; draw the one with the acute angle (the usual textbook figure).
      const otherAngle = deg(Math.asin(Math.min(1, sinOther)));
      const thirdAngle = 180 - (g[opposite] ?? 0) - otherAngle;
      if (thirdAngle <= 0) return "those sides and angle don't make a triangle";
      const z = (known * Math.sin(rad(thirdAngle))) / Math.sin(rad(g[opposite] ?? 0));
      return fromSides(...ordered({ [s1]: x, [s2]: y, [third]: z }));
    }
    // Two sides and nothing else: the angle between them is drawn at 60°.
    const z = Math.sqrt(x * x + y * y - x * y);
    return fromSides(...ordered({ [s1]: x, [s2]: y, [third]: z }));
  }

  if (sides.length === 1) {
    const side = sides[0] ?? "c";
    const length = g[side] ?? 1;
    if (angles.length === 0) return fromSides(length, length, length);
    // One angle and a side: draw it isosceles about that angle (its other two angles equal).
    const [only] = angles as [TriangleVertex];
    const known = g[only] ?? 60;
    const rest = (180 - known) / 2;
    const all = { A: rest, B: rest, C: rest, [only]: known } as Record<TriangleVertex, number>;
    return solve({ [side]: length, ...all });
  }

  // No sides: angles alone set the shape.
  if (angles.length === 1) {
    const [only] = angles as [TriangleVertex];
    const known = g[only] ?? 60;
    if (Math.abs(known - 90) <= ANGLE_TOLERANCE) {
      // A right triangle by default is the 3-4-5 one, the right angle between 3 and 4.
      const [p, q] = VERTICES.filter((v) => v !== only) as [TriangleVertex, TriangleVertex];
      return solve({ [SIDE_OF[only]]: 5, [SIDE_OF[p]]: 4, [SIDE_OF[q]]: 3 });
    }
    const rest = (180 - known) / 2;
    return solve({ A: rest, B: rest, C: rest, [only]: known });
  }
  // Nothing at all: a scalene triangle that doesn't look special.
  return solve({ A: 55, B: 65, C: 60 });
}

type Side = "a" | "b" | "c";

function upper(side: Side): TriangleVertex {
  return side.toUpperCase() as TriangleVertex;
}

function ordered(lengths: Partial<Record<Side, number>>): [number, number, number] {
  return [lengths.a ?? 1, lengths.b ?? 1, lengths.c ?? 1];
}

function fromSides(a: number, b: number, c: number): Full | string {
  const angle = (opposite: number, x: number, y: number) =>
    deg(Math.acos(clamp((x * x + y * y - opposite * opposite) / (2 * x * y), -1, 1)));
  const A = angle(a, b, c);
  const B = angle(b, a, c);
  const C = 180 - A - B;
  if (!(A > 0 && B > 0 && C > 0)) return "those sides don't make a triangle";
  return { a, b, c, A, B, C };
}

/**
 * Given sides keep their lengths. With no length given, the solved shape is returned as is (the
 * renderer scales it to fit). Sides given beyond what fixed the shape must agree with it.
 */
function lengthScale(given: Given, solved: Full): number | string {
  const sides = (["a", "b", "c"] as const).filter((s) => given[s] !== undefined);
  const first = sides[0];
  if (!first) return 1;
  const scale = (given[first] ?? 1) / solved[first];
  for (const s of sides) {
    const want = given[s] ?? 0;
    if (Math.abs(solved[s] * scale - want) > LENGTH_TOLERANCE * want) {
      return `side ${s} would be ${fmt(solved[s] * scale)}, not ${fmt(want)}`;
    }
  }
  return scale;
}

function clamp(v: number, min: number, max: number) {
  return Math.min(max, Math.max(min, v));
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

function fmt(n: number): string {
  return String(round(n));
}
