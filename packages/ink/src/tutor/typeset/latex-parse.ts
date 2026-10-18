/**
 * Parser for the practical LaTeX subset the tutor writes: groups, ^ and _, \frac, \sqrt[n],
 * Greek letters, operators, relations, arrows, big operators, function names, \text and accents.
 * Model output is untrusted, so nesting depth and size are capped; anything outside the subset is
 * a LatexError and the caller falls back to plain text.
 */

export type MathNode =
  | { k: "sym"; c: string }
  | { k: "text"; s: string }
  | { k: "row"; items: MathNode[] }
  | { k: "frac"; num: MathNode; den: MathNode }
  | { k: "sqrt"; body: MathNode; index?: MathNode }
  | { k: "scripts"; base: MathNode; sup?: MathNode; sub?: MathNode }
  | { k: "space"; w: number }
  | { k: "accent"; kind: "vec" | "bar" | "hat" | "dot"; body: MathNode }
  | { k: "bigop"; c: string };

export class LatexError extends Error {
  override readonly name = "LatexError";
}

const MAX_DEPTH = 10;
const MAX_NODES = 400;

export const GREEK: Record<string, string> = {
  alpha: "α",
  beta: "β",
  gamma: "γ",
  delta: "δ",
  epsilon: "ε",
  varepsilon: "ε",
  zeta: "ζ",
  eta: "η",
  theta: "θ",
  vartheta: "θ",
  iota: "ι",
  kappa: "κ",
  lambda: "λ",
  mu: "μ",
  nu: "ν",
  xi: "ξ",
  omicron: "ο",
  pi: "π",
  rho: "ρ",
  varrho: "ρ",
  sigma: "σ",
  tau: "τ",
  upsilon: "υ",
  phi: "φ",
  varphi: "φ",
  chi: "χ",
  psi: "ψ",
  omega: "ω",
  Gamma: "Γ",
  Delta: "Δ",
  Theta: "Θ",
  Lambda: "Λ",
  Xi: "Ξ",
  Pi: "Π",
  Sigma: "Σ",
  Upsilon: "Υ",
  Phi: "Φ",
  Psi: "Ψ",
  Omega: "Ω",
};

export const SYMBOLS: Record<string, string> = {
  ...GREEK,
  cdot: "·",
  times: "×",
  div: "÷",
  pm: "±",
  mp: "∓",
  le: "≤",
  leq: "≤",
  ge: "≥",
  geq: "≥",
  ne: "≠",
  neq: "≠",
  approx: "≈",
  equiv: "≡",
  sim: "∼",
  propto: "∝",
  infty: "∞",
  partial: "∂",
  nabla: "∇",
  to: "→",
  rightarrow: "→",
  longrightarrow: "→",
  leftarrow: "←",
  gets: "←",
  uparrow: "↑",
  downarrow: "↓",
  leftrightarrow: "↔",
  Rightarrow: "⇒",
  implies: "⇒",
  rightleftharpoons: "⇌",
  rightleftarrows: "⇌",
  therefore: "∴",
  angle: "∠",
  perp: "⊥",
  in: "∈",
  subset: "⊂",
  supset: "⊃",
  cup: "∪",
  cap: "∩",
  exists: "∃",
  aleph: "ℵ",
  circ: "°",
  degree: "°",
  prime: "'",
  lt: "<",
  gt: ">",
  ldots: "...",
  dots: "...",
  cdots: "···",
  "{": "{",
  "}": "}",
  "%": "%",
  $: "$",
  "#": "#",
  "&": "&",
  _: "_",
  "|": "‖",
};

const BIG_OPS: Record<string, string> = { sum: "∑", prod: "∏", int: "∫", oint: "∫" };

/** Upright function names written as text. */
const FUNCTIONS = new Set([
  "sin",
  "cos",
  "tan",
  "sec",
  "csc",
  "cot",
  "arcsin",
  "arccos",
  "arctan",
  "sinh",
  "cosh",
  "tanh",
  "log",
  "ln",
  "lg",
  "exp",
  "lim",
  "max",
  "min",
  "det",
  "gcd",
  "mod",
]);

const SPACES: Record<string, number> = {
  ",": 0.25,
  ":": 0.3,
  ";": 0.4,
  "!": -0.12,
  " ": 0.4,
  quad: 1.5,
  qquad: 3,
};

/** Commands that only affect sizing or style: their argument (if any) is laid out normally. */
const IGNORED = new Set([
  "left",
  "right",
  "big",
  "Big",
  "bigg",
  "Bigg",
  "bigl",
  "bigr",
  "Bigl",
  "Bigr",
  "displaystyle",
  "textstyle",
  "limits",
  "nolimits",
]);
const STYLE_WRAPPERS = new Set(["mathrm", "mathbf", "mathit", "mathsf", "boldsymbol", "mathcal"]);
const TEXT_WRAPPERS = new Set(["text", "textrm", "textit", "textbf", "mbox", "operatorname"]);
const ACCENTS: Record<string, "vec" | "bar" | "hat" | "dot"> = {
  vec: "vec",
  overrightarrow: "vec",
  bar: "bar",
  overline: "bar",
  hat: "hat",
  widehat: "hat",
  dot: "dot",
};

type Token = { t: "cmd" | "char" | "{" | "}" | "^" | "_" | "[" | "]"; v: string };

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  for (let i = 0; i < src.length;) {
    const ch = String.fromCodePoint(src.codePointAt(i) ?? 0);
    if (ch === "\\") {
      const name = /^[a-zA-Z]+/.exec(src.slice(i + 1))?.[0];
      if (name) {
        tokens.push({ t: "cmd", v: name });
        i += 1 + name.length;
      } else {
        tokens.push({ t: "cmd", v: src[i + 1] ?? "" });
        i += 2;
      }
      continue;
    }
    if (ch === "{" || ch === "}" || ch === "^" || ch === "_" || ch === "[" || ch === "]") {
      tokens.push({ t: ch, v: ch });
    } else {
      tokens.push({ t: "char", v: ch });
    }
    i += ch.length;
  }
  return tokens;
}

class Parser {
  private pos = 0;
  private nodes = 0;

  constructor(
    private readonly tokens: Token[],
    private readonly src: string,
  ) {}

  parseAll(): MathNode {
    const row = this.row(0, null);
    if (this.pos < this.tokens.length) throw new LatexError("unbalanced braces");
    return row;
  }

  /** Atoms until `stop` (a closing token) or the end. */
  private row(depth: number, stop: "}" | "]" | null): MathNode {
    if (depth > MAX_DEPTH) throw new LatexError("nested too deeply");
    const items: MathNode[] = [];
    while (this.pos < this.tokens.length) {
      const tok = this.peek();
      if (stop && tok?.t === stop) break;
      if (tok?.t === "}") throw new LatexError("unbalanced braces");
      const atom = this.atom(depth);
      if (atom) items.push(atom);
    }
    return items.length === 1 && items[0] ? items[0] : this.node({ k: "row", items });
  }

  /** A base followed by any ^ / _ scripts. */
  private atom(depth: number): MathNode | null {
    let base = this.base(depth);
    let sup: MathNode | undefined;
    let sub: MathNode | undefined;
    for (;;) {
      const tok = this.peek();
      if (tok?.t === "^" && !sup) {
        this.pos++;
        sup = this.argument(depth + 1);
      } else if (tok?.t === "_" && !sub) {
        this.pos++;
        sub = this.argument(depth + 1);
      } else if (tok?.t === "cmd" && tok.v === "prime") {
        this.pos++;
        base = this.node({ k: "row", items: [base ?? this.sym(""), this.sym("'")] });
      } else {
        break;
      }
    }
    if (!sup && !sub) return base;
    return this.node({
      k: "scripts",
      base: base ?? this.node({ k: "row", items: [] }),
      ...(sup && { sup }),
      ...(sub && { sub }),
    });
  }

  private base(depth: number): MathNode | null {
    const tok = this.next();
    if (!tok) throw new LatexError("unexpected end");
    switch (tok.t) {
      case "{": {
        const inner = this.row(depth + 1, "}");
        this.expect("}");
        return inner;
      }
      case "char":
        return /\s/.test(tok.v) ? null : this.sym(tok.v);
      case "[":
      case "]":
        return this.sym(tok.v);
      case "^":
      case "_":
        // A script with no base (e.g. "^2" at the start): attach to an empty base.
        this.pos--;
        return this.node({ k: "row", items: [] });
      case "}":
        throw new LatexError("unbalanced braces");
      case "cmd":
        return this.command(tok.v, depth);
    }
  }

  private command(name: string, depth: number): MathNode | null {
    if (name === "frac" || name === "dfrac" || name === "tfrac" || name === "cfrac") {
      const num = this.argument(depth + 1);
      const den = this.argument(depth + 1);
      return this.node({ k: "frac", num, den });
    }
    if (name === "sqrt") {
      let index: MathNode | undefined;
      if (this.peek()?.t === "[") {
        this.pos++;
        index = this.row(depth + 1, "]");
        this.expect("]");
      }
      const body = this.argument(depth + 1);
      return this.node({ k: "sqrt", body, ...(index && { index }) });
    }
    if (TEXT_WRAPPERS.has(name)) return this.node({ k: "text", s: this.rawGroup() });
    if (STYLE_WRAPPERS.has(name)) return this.argument(depth + 1);
    const accent = ACCENTS[name];
    if (accent) return this.node({ k: "accent", kind: accent, body: this.argument(depth + 1) });
    if (IGNORED.has(name)) {
      // \left. and \right. are invisible delimiters.
      if ((name === "left" || name === "right") && this.peek()?.v === ".") this.pos++;
      return null;
    }
    if (name in SPACES) return this.node({ k: "space", w: SPACES[name] ?? 0 });
    if (name === "\\") return this.node({ k: "space", w: 1 });
    const big = BIG_OPS[name];
    if (big) return this.node({ k: "bigop", c: big });
    if (FUNCTIONS.has(name)) return this.node({ k: "text", s: name });
    const symbol = SYMBOLS[name];
    if (symbol !== undefined) return this.sym(symbol);
    throw new LatexError(`unsupported command \\${name}`);
  }

  /** A braced group or a single token (as in x^2 or \frac12). */
  private argument(depth: number): MathNode {
    while (this.peek()?.t === "char" && /\s/.test(this.peek()?.v ?? "")) this.pos++;
    const tok = this.peek();
    if (!tok) throw new LatexError("missing argument");
    if (tok.t === "{") {
      this.pos++;
      const inner = this.row(depth, "}");
      this.expect("}");
      return inner;
    }
    const base = this.base(depth);
    return base ?? this.node({ k: "row", items: [] });
  }

  /** The literal contents of a braced group (for \text), spaces kept. */
  private rawGroup(): string {
    this.expect("{");
    let text = "";
    let level = 0;
    while (this.pos < this.tokens.length) {
      const tok = this.next();
      if (!tok) break;
      if (tok.t === "{") level++;
      if (tok.t === "}") {
        if (level === 0) return text;
        level--;
      }
      text += tok.t === "cmd" ? (SYMBOLS[tok.v] ?? tok.v) : tok.v;
    }
    throw new LatexError("unbalanced braces");
  }

  private sym(c: string): MathNode {
    return this.node({ k: "sym", c });
  }

  private node<T extends MathNode>(node: T): T {
    if (++this.nodes > MAX_NODES) throw new LatexError("expression too large");
    return node;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token | undefined {
    return this.tokens[this.pos++];
  }

  private expect(t: Token["t"]): void {
    if (this.next()?.t !== t) throw new LatexError(`expected ${t} in ${this.src.slice(0, 40)}`);
  }
}

/** Parses LaTeX (with or without surrounding $…$ / \( \) / \[ \]). Throws LatexError. */
export function parseLatex(latex: string): MathNode {
  const src = latex
    .trim()
    .replace(/^\$\$?([\s\S]*?)\$\$?$/, "$1")
    .replace(/^\\[([]([\s\S]*?)\\[)\]]$/, "$1");
  return new Parser(tokenize(src), src).parseAll();
}

/**
 * Best-effort plain text for LaTeX the parser rejects: known commands become symbols, fractions
 * become a/b, and the remaining markup is dropped.
 */
export function latexToPlainText(latex: string): string {
  return latex
    .replace(/\\[dtc]?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, "($1)/($2)")
    .replace(/\\sqrt\s*\{([^{}]*)\}/g, "√($1)")
    .replace(/\\([a-zA-Z]+)/g, (_, name: string) =>
      FUNCTIONS.has(name) ? name : (SYMBOLS[name] ?? BIG_OPS[name] ?? name),
    )
    .replace(/\\(.)/g, "$1")
    .replace(/[{}$]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
