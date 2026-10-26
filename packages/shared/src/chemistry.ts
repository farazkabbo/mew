/**
 * Atom and charge balance for chemical equations (brief §7), from plain text or LaTeX as
 * recognised from handwriting: "2H2 + O2 -> 2H2O", "Cu^{2+} + 2e^- \rightarrow Cu",
 * "CuSO_4\cdot 5H_2O". Anything it can't parse is "unknown", never a guess.
 */

export type BalanceResult =
  | { verdict: "correct"; reason: "balanced" }
  | { verdict: "incorrect"; reason: "unbalanced"; detail: string }
  | { verdict: "unknown"; reason: "unparseable" | "not_an_equation" };

type Counts = Map<string, number>;

const ARROW =
  /\\(?:rightleftharpoons|rightleftarrows|rightarrow|longrightarrow|to)|⇌|⟶|→|->|=+>|<=>|=/;
const MAX_CHARS = 300;
const MAX_COEFFICIENT = 1000;
const ELEMENT = /^[A-Z][a-z]?/;

export function checkBalance(input: string): BalanceResult {
  if (input.length > MAX_CHARS) return { verdict: "unknown", reason: "unparseable" };
  const text = normalise(input);
  const sides = text.split(ARROW);
  if (sides.length !== 2) return { verdict: "unknown", reason: "not_an_equation" };
  try {
    const [left, right] = sides.map((side) => sumSide(side)) as [Side, Side];
    const problems: string[] = [];
    const elements = new Set([...left.atoms.keys(), ...right.atoms.keys()]);
    for (const el of [...elements].sort()) {
      const l = left.atoms.get(el) ?? 0;
      const r = right.atoms.get(el) ?? 0;
      if (l !== r) problems.push(`${el}: ${l} on the left, ${r} on the right`);
    }
    if (left.charge !== right.charge) {
      problems.push(
        `charge: ${signed(left.charge)} on the left, ${signed(right.charge)} on the right`,
      );
    }
    return problems.length === 0
      ? { verdict: "correct", reason: "balanced" }
      : { verdict: "incorrect", reason: "unbalanced", detail: problems.join("; ") };
  } catch {
    return { verdict: "unknown", reason: "unparseable" };
  }
}

/** Whether a line looks like a chemical equation worth balance-checking. */
export function looksLikeReaction(input: string): boolean {
  const text = normalise(input);
  return text.split(ARROW).length === 2 && /[A-Z]/.test(text);
}

/**
 * Whether two equations are the same reaction, however they're balanced: the same species on
 * each side, coefficients aside ("H2 + O2 -> H2O" and "2H2 + O2 → 2H2O"). False if either can't
 * be read as an equation.
 */
export function sameReaction(a: string, b: string): boolean {
  const left = speciesOf(a);
  const right = speciesOf(b);
  return left !== null && right !== null && left === right;
}

/** "H2+O2>H2O": each side's species without coefficients, sorted; null if not an equation. */
function speciesOf(input: string): string | null {
  const sides = normalise(input).split(ARROW);
  if (sides.length !== 2) return null;
  const parts = sides.map((side) =>
    side
      .split("+")
      .map((s) => s.trim().replace(/^\d+\s*/, ""))
      .sort(),
  );
  if (parts.some((side) => side.length === 0 || side.some((s) => !s))) return null;
  return parts.map((side) => side.join("+")).join(">");
}

type Side = { atoms: Counts; charge: number };

function normalise(input: string): string {
  return (
    input
      .replace(/\$/g, "")
      .replace(/\\(?:text|mathrm|ce)\s*\{([^{}]*)\}/g, "$1")
      .replace(/\\(?:cdot|bullet)|[·•∙]/g, "·")
      .replace(/\\,|\\;|\\!|\\quad/g, " ")
      // Charges: ^{2+}, ^+, ^{-}, ^{3-} → [p2], [p], [m], [m3]: no + or - left to confuse
      // splitting species on '+' or spotting '->'.
      .replace(/\^\{?\s*(\d*)\s*([+-])\s*\}?/g, (_, n: string, sign: string) =>
        sign === "+" ? `[p${n}]` : `[m${n}]`,
      )
      .replace(/[_{}]/g, "")
      .replace(/\((?:aq|s|l|g)\)/g, "")
      .replace(/\s+/g, " ")
      .trim()
  );
}

function sumSide(side: string): Side {
  const species = side.split("+").map((s) => s.trim());
  if (species.some((s) => s.length === 0)) throw new Error("empty species");
  const atoms: Counts = new Map();
  let charge = 0;
  for (const raw of species) {
    const match = /^(\d+)?\s*(.*)$/.exec(raw);
    const coefficient = Number(match?.[1] ?? 1);
    if (coefficient < 1 || coefficient > MAX_COEFFICIENT) throw new Error("bad coefficient");
    const { formula, charge: ionCharge } = splitCharge(match?.[2] ?? "");
    charge += coefficient * ionCharge;
    if (formula === "e") continue; // an electron: charge only
    for (const [el, n] of parseFormula(formula)) {
      atoms.set(el, (atoms.get(el) ?? 0) + coefficient * n);
    }
  }
  return { atoms, charge };
}

function splitCharge(text: string): { formula: string; charge: number } {
  const match = /\[([pm])(\d*)\]$/.exec(text);
  if (!match) {
    if (/\[[pm]\d*\]/.test(text)) throw new Error("misplaced charge");
    return { formula: text.trim(), charge: 0 };
  }
  const size = Number(match[2] || 1);
  return { formula: text.slice(0, match.index).trim(), charge: match[1] === "m" ? -size : size };
}

/** Element counts of a formula with groups and hydrates: Ca(OH)2, CuSO4·5H2O. */
function parseFormula(formula: string): Counts {
  const total: Counts = new Map();
  for (const part of formula.split("·")) {
    const match = /^(\d+)?(.*)$/.exec(part.trim());
    const multiplier = Number(match?.[1] ?? 1);
    const [counts, rest] = parseGroup(match?.[2] ?? "", 0);
    if (rest !== (match?.[2] ?? "").length) throw new Error("trailing characters");
    for (const [el, n] of counts) total.set(el, (total.get(el) ?? 0) + multiplier * n);
  }
  if (total.size === 0) throw new Error("no elements");
  return total;
}

function parseGroup(text: string, start: number, depth = 0): [Counts, number] {
  if (depth > 4) throw new Error("nested too deeply");
  const counts: Counts = new Map();
  let i = start;
  while (i < text.length) {
    const ch = text[i] ?? "";
    if (ch === "(" || ch === "[") {
      const [inner, end] = parseGroup(text, i + 1, depth + 1);
      if (text[end] !== (ch === "(" ? ")" : "]")) throw new Error("unclosed group");
      const [n, next] = number(text, end + 1);
      for (const [el, k] of inner) counts.set(el, (counts.get(el) ?? 0) + n * k);
      i = next;
    } else if (ch === ")" || ch === "]") {
      return [counts, i];
    } else if (ch === " ") {
      i++;
    } else {
      const element = ELEMENT.exec(text.slice(i))?.[0];
      if (!element) throw new Error(`unexpected ${ch}`);
      const [n, next] = number(text, i + element.length);
      counts.set(element, (counts.get(element) ?? 0) + n);
      i = next;
    }
  }
  return [counts, i];
}

function number(text: string, at: number): [number, number] {
  const digits = /^\d+/.exec(text.slice(at))?.[0];
  if (!digits) return [1, at];
  const n = Number(digits);
  if (n > MAX_COEFFICIENT) throw new Error("number too large");
  return [n, at + digits.length];
}

function signed(n: number): string {
  return n > 0 ? `+${n}` : String(n);
}
