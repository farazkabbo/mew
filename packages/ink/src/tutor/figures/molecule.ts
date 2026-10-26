import { FIGURE_LIMITS, type MoleculeFigure } from "@mew/shared";

import type { Path } from "../visuals/rough";
import {
  add,
  type Figure,
  type FigureFrame,
  type FigureLabel,
  fitInto,
  length,
  lerp,
  mul,
  sub,
  unit,
  type Vec,
} from "./figure";

/**
 * Molecules from SMILES (K5, NOTEBOOKS_K §3.3 and decision 3). smiles-drawer (MIT) parses the
 * SMILES and lays the atoms out; we take only its coordinates and bond orders and draw the bonds
 * ourselves, by hand, one stroke each. Its SVG and canvas output are never used. It's loaded on
 * the first molecule (a dynamic import), and a layout is kept per SMILES.
 */
export type MoleculeAtom = {
  element: string;
  position: Vec;
  /** Implicit hydrogens to write next to a labelled atom. */
  hydrogens: number;
  charge: number;
  aromatic: boolean;
  /** Ring atoms whose ring is a circle of bonds: used to put double bonds inside the ring. */
  ringCentre: Vec | null;
};

export type MoleculeBond = { from: number; to: number; order: 1 | 2 | 3; aromatic: boolean };

export type MoleculeLayout = {
  /** Indexed by the atom's 0-based order in the SMILES; undefined for atoms not drawn. */
  atoms: (MoleculeAtom | undefined)[];
  bonds: MoleculeBond[];
  /** Aromatic rings: their centres and size (the circle style draws a ring inside them). */
  aromaticRings: { centre: Vec; radius: number; members: number[] }[];
};

const layouts = new Map<string, MoleculeLayout | string>();

/** Lays out a SMILES string (loading smiles-drawer the first time). A reason when it can't. */
export async function loadMolecule(smiles: string): Promise<MoleculeLayout | string> {
  const known = layouts.get(smiles);
  if (known !== undefined) return known;
  let result: MoleculeLayout | string;
  try {
    const { default: SmilesDrawer } = await import("smiles-drawer");
    result = layoutWith(SmilesDrawer, smiles);
  } catch {
    result = "the molecule couldn't be read";
  }
  layouts.set(smiles, result);
  return result;
}

/** A layout already loaded (synchronous planners load first, then draw). */
export function cachedMolecule(smiles: string): MoleculeLayout | string | undefined {
  return layouts.get(smiles);
}

// ─── smiles-drawer's layout ─────────────────────────────────────────────────────────────────

/** The parts of smiles-drawer we read (its layout step, `DrawerBase`, needs no DOM). */
type SmilesDrawerApi = {
  Parser: { parse(smiles: string): unknown };
  SvgDrawer: new (options: object) => { preprocessor: DrawerBase };
};
type DrawerBase = {
  initDraw(tree: unknown, theme: string, infoOnly: boolean, highlight: unknown[]): void;
  processGraph(): void;
  graph: {
    vertices: {
      id: number;
      position: { x: number; y: number };
      value: {
        element: string;
        isDrawn: boolean;
        isPartOfAromaticRing: boolean;
        bracket: { charge?: number } | null;
        countImplicitHydrogens(): number;
      };
    }[];
    edges: {
      sourceId: number;
      targetId: number;
      bondType: string;
      isPartOfAromaticRing: boolean;
    }[];
  };
  rings: { members: number[] }[];
};

function layoutWith(api: SmilesDrawerApi, smiles: string): MoleculeLayout | string {
  let tree: unknown;
  try {
    tree = api.Parser.parse(smiles);
  } catch {
    return "that isn't a SMILES string";
  }
  // A fresh drawer per molecule: its layout keeps state between draws.
  const base = new api.SvgDrawer({ compactDrawing: false }).preprocessor;
  base.initDraw(tree, "light", false, []);
  base.processGraph();
  const vertices = base.graph.vertices;
  const drawn = vertices.filter((v) => v.value.isDrawn);
  if (drawn.length === 0) return "the molecule has no atoms";
  if (drawn.length > FIGURE_LIMITS.atoms) return "the molecule is too big to sketch";

  const ringOf = new Map<number, Vec>();
  const aromaticRings: MoleculeLayout["aromaticRings"] = [];
  for (const ring of base.rings) {
    const points = ring.members.flatMap((id) => {
      const v = vertices[id];
      return v ? [[v.position.x, v.position.y] as Vec] : [];
    });
    if (points.length < 3) continue;
    const centre = mul(points.reduce<Vec>(add, [0, 0]), 1 / points.length);
    for (const id of ring.members) if (!ringOf.has(id)) ringOf.set(id, centre);
    if (ring.members.every((id) => vertices[id]?.value.isPartOfAromaticRing)) {
      const radius = Math.min(...points.map((p) => length(sub(p, centre))));
      aromaticRings.push({ centre, radius, members: [...ring.members] });
    }
  }

  const atoms: MoleculeLayout["atoms"] = vertices.map((v) => {
    if (!v.value.isDrawn) return undefined;
    const { element, isPartOfAromaticRing: aromatic, bracket } = v.value;
    // smiles-drawer's own rule: an aromatic nitrogen is drawn without hydrogens unless [nH].
    const hydrogens =
      element === "N" && aromatic && !bracket ? 0 : Math.max(0, v.value.countImplicitHydrogens());
    return {
      element,
      position: [v.position.x, v.position.y],
      hydrogens,
      charge: bracket?.charge ?? 0,
      aromatic,
      ringCentre: ringOf.get(v.id) ?? null,
    };
  });
  const bonds: MoleculeBond[] = base.graph.edges
    .filter((e) => atoms[e.sourceId] && atoms[e.targetId])
    .map((e) => ({
      from: e.sourceId,
      to: e.targetId,
      order: e.bondType === "#" ? 3 : e.bondType === "=" ? 2 : 1,
      aromatic: e.isPartOfAromaticRing,
    }));
  return { atoms, bonds, aromaticRings };
}

// ─── Drawing ────────────────────────────────────────────────────────────────────────────────

const LABEL = 0.85;

/**
 * Builds the figure for a laid-out molecule in `frame`: skeletal formula (carbons as corners,
 * other atoms written with their hydrogens), double and triple bonds as parallel strokes, and
 * aromatic rings as alternating double bonds or a circle.
 */
export function moleculeFigure(
  layout: MoleculeLayout,
  spec: Pick<MoleculeFigure, "aromaticStyle" | "highlightAtoms" | "atomLabels">,
  frame: FigureFrame,
): Figure | string {
  const u = frame.unit;
  const present = layout.atoms.flatMap((a, i) => (a ? [i] : []));
  const positions = present.map((i): Vec => layout.atoms[i]?.position ?? [0, 0]);
  // A lone atom (methane, water) has no extent: fit a small box round it.
  const extent: Vec[] =
    positions.length > 1 ? positions : [...positions, add(positions[0] ?? [0, 0], [30, 0])];
  const fitted = fitInto(extent, frame.rect, 1.8 * u);
  // Bonds are kept a readable length: a small molecule isn't blown up to fill the card.
  const bondPx = Math.min(fitted.scale * 30, 6 * u);
  const shrink = bondPx / 30 / fitted.scale;
  const xs = extent.map((p) => p[0]);
  const ys = extent.map((p) => p[1]);
  const centre: Vec = [
    (Math.min(...xs) + Math.max(...xs)) / 2,
    (Math.min(...ys) + Math.max(...ys)) / 2,
  ];
  const map = (p: Vec): Vec => fitted.map(lerp(centre, p, shrink));
  const at = (i: number): Vec => map(layout.atoms[i]?.position ?? [0, 0]);

  const labelled = new Set(
    present.filter((i) => {
      const atom = layout.atoms[i];
      return atom && (atom.element !== "C" || atom.charge !== 0 || present.length < 3);
    }),
  );
  const style = spec.aromaticStyle ?? "kekule";
  const kekule = style === "kekule" ? kekulise(layout) : null;
  // Kekulé falls back to circles when the rings have no alternating structure.
  const circles = style === "circle" || kekule === null;

  const { pen } = frame;
  const paths: Path[] = [];
  const gap = 0.16 * bondPx;
  const trim = 0.65 * u;
  for (const [k, bond] of layout.bonds.entries()) {
    let from = at(bond.from);
    let to = at(bond.to);
    const along = unit(sub(to, from));
    if (labelled.has(bond.from)) from = add(from, mul(along, trim));
    if (labelled.has(bond.to)) to = sub(to, mul(along, trim));
    const order = bond.aromatic ? (kekule === null ? 1 : (kekule.get(k) ?? 1)) : bond.order;
    const normal: Vec = [-along[1], along[0]];
    const line = (p: Vec, q: Vec) => paths.push(...pen.line(p[0], p[1], q[0], q[1]));
    if (order === 1) {
      line(from, to);
    } else if (order === 2) {
      const ring = ringCentreOf(layout, bond);
      if (ring) {
        // In a ring the second stroke sits inside it, a little shorter.
        const middle = lerp(from, to, 0.5);
        const inward = mul(unit(sub(map(ring), middle)), gap * 1.3);
        const side = Math.sign(inward[0] * normal[0] + inward[1] * normal[1]) || 1;
        const offset = mul(normal, side * gap * 1.3);
        line(from, to);
        line(add(lerp(from, to, 0.15), offset), add(lerp(from, to, 0.85), offset));
      } else {
        line(add(from, mul(normal, gap / 2)), add(to, mul(normal, gap / 2)));
        line(sub(from, mul(normal, gap / 2)), sub(to, mul(normal, gap / 2)));
      }
    } else {
      line(from, to);
      line(add(from, mul(normal, gap)), add(to, mul(normal, gap)));
      line(sub(from, mul(normal, gap)), sub(to, mul(normal, gap)));
    }
  }
  if (circles) {
    for (const ring of layout.aromaticRings) {
      const c = map(ring.centre);
      const r = ring.radius * fitted.scale * shrink * 0.6;
      paths.push(...pen.ellipse(c[0], c[1], 2 * r, 2 * r));
    }
  }

  const labels: FigureLabel[] = [];
  for (const i of labelled) {
    const atom = layout.atoms[i];
    if (!atom) continue;
    labels.push({ text: atomText(layout, i), at: at(i), scale: LABEL });
  }
  const accents: Path[] = [];
  for (const i of spec.highlightAtoms ?? []) {
    if (!layout.atoms[i]) continue;
    const [x, y] = at(i);
    const r = 0.8 * u;
    accents.push(
      Array.from({ length: 17 }, (_, k) => {
        const t = (k / 16) * 2 * Math.PI;
        return [x + r * Math.cos(t), y + r * Math.sin(t)] as Vec;
      }),
    );
  }
  for (const { index, text } of spec.atomLabels ?? []) {
    if (!layout.atoms[index]) continue;
    const out = awayFromNeighbours(layout, index);
    labels.push({ text, at: add(at(index), mul(out, 1.9 * u)), scale: LABEL * 0.85 });
  }
  if (paths.length === 0 && labels.length === 0) return "nothing to draw";
  return { paths, accents, labels };
}

/** "OH", "HO" (bonds to its right), "NH2", "O−". */
function atomText(layout: MoleculeLayout, index: number): string {
  const atom = layout.atoms[index];
  if (!atom) return "";
  const h = atom.hydrogens === 0 ? "" : atom.hydrogens === 1 ? "H" : `H${atom.hydrogens}`;
  const charge =
    atom.charge === 0
      ? ""
      : `${Math.abs(atom.charge) > 1 ? Math.abs(atom.charge) : ""}${atom.charge > 0 ? "+" : "−"}`;
  const neighbours = neighboursOf(layout, index);
  const meanX =
    neighbours.reduce((n, j) => n + (layout.atoms[j]?.position[0] ?? 0), 0) /
    Math.max(1, neighbours.length);
  // Hydrogens go on the side away from the bonds; a lone O or S is written H2O, H2S.
  const hLeft =
    h !== "" &&
    (neighbours.length > 0
      ? meanX > atom.position[0] + 1
      : atom.element === "O" || atom.element === "S");
  return `${hLeft ? h : ""}${atom.element}${hLeft ? "" : h}${charge}`;
}

function neighboursOf(layout: MoleculeLayout, index: number): number[] {
  return layout.bonds.flatMap((b) => (b.from === index ? [b.to] : b.to === index ? [b.from] : []));
}

function awayFromNeighbours(layout: MoleculeLayout, index: number): Vec {
  const atom = layout.atoms[index];
  if (!atom) return [0, -1];
  const pull = neighboursOf(layout, index).reduce<Vec>(
    (sum, j) => add(sum, unit(sub(layout.atoms[j]?.position ?? atom.position, atom.position))),
    [0, 0],
  );
  const away = unit(mul(pull, -1));
  return length(away) === 0 ? [0, -1] : away;
}

/** A ring both ends of a bond belong to (the same one), for placing its inner second stroke. */
function ringCentreOf(layout: MoleculeLayout, bond: MoleculeBond): Vec | null {
  const a = layout.atoms[bond.from]?.ringCentre;
  const b = layout.atoms[bond.to]?.ringCentre;
  return a && b && a[0] === b[0] && a[1] === b[1] ? a : null;
}

/**
 * Alternating single and double bonds for the aromatic rings (a Kekulé structure): a perfect
 * matching of the aromatic atoms that need a double bond, found by backtracking (molecules here
 * are small). Null when there isn't one; the rings are then drawn with circles.
 */
export function kekulise(layout: MoleculeLayout): Map<number, 1 | 2> | null {
  const needs = new Set<number>();
  layout.atoms.forEach((atom, i) => {
    if (!atom?.aromatic) return;
    // Carbons always take part; N, P without hydrogens do; O, S (and [nH]) give a lone pair.
    const element = atom.element.toUpperCase();
    if (element === "C" || ((element === "N" || element === "P") && atom.hydrogens === 0)) {
      // Unless a double bond outside the ring already fills it (e.g. C=O on a ring).
      const outside = layout.bonds.some(
        (b) => !b.aromatic && b.order === 2 && (b.from === i || b.to === i),
      );
      if (!outside) needs.add(i);
    }
  });
  const candidates = [...layout.bonds.entries()].filter(
    ([, b]) => b.aromatic && needs.has(b.from) && needs.has(b.to),
  );
  const orders = new Map<number, 1 | 2>();
  for (const [k, b] of layout.bonds.entries()) if (b.aromatic) orders.set(k, 1);
  const matched = new Set<number>();
  const atoms = [...needs].sort((x, y) => x - y);
  let budget = 20_000;

  const search = (position: number): boolean => {
    if (--budget < 0) return false;
    let next = position;
    while (next < atoms.length && matched.has(atoms[next] ?? -1)) next++;
    if (next >= atoms.length) return true;
    const atom = atoms[next] ?? -1;
    for (const [k, b] of candidates) {
      if (b.from !== atom && b.to !== atom) continue;
      const other = b.from === atom ? b.to : b.from;
      if (matched.has(other)) continue;
      matched.add(atom);
      matched.add(other);
      orders.set(k, 2);
      if (search(next + 1)) return true;
      orders.set(k, 1);
      matched.delete(atom);
      matched.delete(other);
    }
    return false;
  };
  return search(0) ? orders : null;
}
