/**
 * A small, safe maths expression compiler for plots: "y = sin(x)", "2x^2 - 3", "\sqrt{x}",
 * "e^(-x)". Builds closures from a parse tree; never uses eval. Input comes from a model, so
 * length and nesting are capped and anything unexpected is an ExprError.
 */

export type Fn = (x: number) => number;

export class ExprError extends Error {
  override readonly name = "ExprError";
}

const MAX_CHARS = 80;
const MAX_DEPTH = 30;

const FUNCTIONS: Record<string, (v: number) => number> = {
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  asin: Math.asin,
  acos: Math.acos,
  atan: Math.atan,
  arcsin: Math.asin,
  arccos: Math.acos,
  arctan: Math.atan,
  sinh: Math.sinh,
  cosh: Math.cosh,
  tanh: Math.tanh,
  sqrt: Math.sqrt,
  abs: Math.abs,
  exp: Math.exp,
  ln: Math.log,
  log: Math.log10,
  floor: Math.floor,
  ceil: Math.ceil,
  sign: Math.sign,
};
const CONSTANTS: Record<string, number> = { pi: Math.PI, e: Math.E, π: Math.PI };

type Token =
  | { t: "num"; v: number }
  | { t: "id"; v: string }
  | { t: "op"; v: "+" | "-" | "*" | "/" | "^" }
  | { t: "(" }
  | { t: ")" };

/** Compiles an expression in x. Throws ExprError. */
export function compileExpression(source: string): Fn {
  if (source.length > MAX_CHARS) throw new ExprError("too long");
  const tokens = tokenize(normalise(source));
  const parser = new Parser(tokens);
  const fn = parser.expression(0);
  if (!parser.done()) throw new ExprError("unexpected input");
  return fn;
}

/** Strips "y =", "f(x) =", LaTeX wrappers and commands down to plain function syntax. */
function normalise(source: string): string {
  return source
    .trim()
    .replace(/^\$|\$$/g, "")
    .replace(/^\s*(?:y|f\s*\(\s*x\s*\))\s*=\s*/i, "")
    .replace(/\\left|\\right|\\,|\\;|\\!/g, "")
    .replace(/\\frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, "(($1)/($2))")
    .replace(/\\sqrt\s*\{([^{}]*)\}/g, "sqrt($1)")
    .replace(/\\(cdot|times)/g, "*")
    .replace(/\\([a-zA-Z]+)/g, "$1")
    .replace(/[{[]/g, "(")
    .replace(/[}\]]/g, ")")
    .replace(/[−–]/g, "-")
    .replace(/[·×]/g, "*")
    .replace(/\*\*/g, "^");
}

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i] ?? "";
    if (/\s/.test(ch)) {
      i++;
    } else if (/[\d.]/.test(ch)) {
      const num = /^\d*\.?\d+(?:e[+-]?\d+)?|^\d+\.?/i.exec(text.slice(i))?.[0] ?? "";
      const v = Number(num);
      if (!num || !Number.isFinite(v)) throw new ExprError("bad number");
      tokens.push({ t: "num", v });
      i += num.length;
    } else if (/[a-zA-Zπ]/.test(ch)) {
      const word = /^[a-zA-Zπ]+/.exec(text.slice(i))?.[0] ?? "";
      tokens.push(...splitWord(word));
      i += word.length;
    } else if ("+-*/^".includes(ch)) {
      tokens.push({ t: "op", v: ch as "+" });
      i++;
    } else if (ch === "(" || ch === ")") {
      tokens.push({ t: ch });
      i++;
    } else {
      throw new ExprError(`unexpected ${ch}`);
    }
  }
  return tokens;
}

/** "xsin" → x, sin; "pix" → pi, x: the longest known name at each position, else one letter. */
function splitWord(word: string): Token[] {
  const names = [...Object.keys(FUNCTIONS), ...Object.keys(CONSTANTS)].sort(
    (a, b) => b.length - a.length,
  );
  const out: Token[] = [];
  let rest = word;
  while (rest) {
    const lower = rest.toLowerCase();
    const name = names.find((n) => lower.startsWith(n)) ?? rest[0] ?? "";
    out.push({ t: "id", v: name.toLowerCase() });
    rest = rest.slice(name.length);
  }
  return out;
}

const PRECEDENCE: Record<string, number> = { "+": 1, "-": 1, "*": 2, "/": 2, "^": 4 };

class Parser {
  private pos = 0;

  constructor(private readonly tokens: Token[]) {}

  done(): boolean {
    return this.pos >= this.tokens.length;
  }

  /** Precedence climbing; implicit multiplication binds like *. */
  expression(depth: number, minPrec = 0): Fn {
    if (depth > MAX_DEPTH) throw new ExprError("nested too deeply");
    let left = this.unary(depth);
    for (;;) {
      const tok = this.tokens[this.pos];
      let op: string | null = null;
      if (tok?.t === "op") op = tok.v;
      else if (tok && (tok.t === "num" || tok.t === "id" || tok.t === "(")) op = "implicit";
      if (!op) break;
      const prec = op === "implicit" ? 3 : (PRECEDENCE[op] ?? 0);
      if (prec < minPrec) break;
      if (op !== "implicit") this.pos++;
      // ^ is right-associative; everything else left.
      const right = this.expression(depth + 1, op === "^" ? prec : prec + 1);
      left = combine(op === "implicit" ? "*" : op, left, right);
    }
    return left;
  }

  private unary(depth: number): Fn {
    const tok = this.tokens[this.pos];
    if (tok?.t === "op" && (tok.v === "-" || tok.v === "+")) {
      this.pos++;
      // -x^2 means -(x^2): the operand binds tighter than unary minus.
      const operand = this.expression(depth + 1, 3);
      return tok.v === "-" ? (x) => -operand(x) : operand;
    }
    return this.primary(depth);
  }

  private primary(depth: number): Fn {
    const tok = this.tokens[this.pos++];
    if (!tok) throw new ExprError("unexpected end");
    if (tok.t === "num") return () => tok.v;
    if (tok.t === "(") {
      const inner = this.expression(depth + 1);
      if (this.tokens[this.pos++]?.t !== ")") throw new ExprError("missing )");
      return inner;
    }
    if (tok.t === "id") {
      if (tok.v === "x") return (x) => x;
      const constant = CONSTANTS[tok.v];
      if (constant !== undefined) return () => constant;
      const fn = FUNCTIONS[tok.v];
      if (fn) {
        // sin x, sin(x), sin^2 x
        let power: Fn | null = null;
        const next = this.tokens[this.pos];
        if (next?.t === "op" && next.v === "^") {
          this.pos++;
          power = this.primary(depth + 1);
        }
        const arg = this.expression(depth + 1, 3);
        const f: Fn = (x) => fn(arg(x));
        return power ? (x) => f(x) ** power(x) : f;
      }
      throw new ExprError(`unknown name ${tok.v}`);
    }
    throw new ExprError("unexpected token");
  }
}

function combine(op: string, a: Fn, b: Fn): Fn {
  switch (op) {
    case "+":
      return (x) => a(x) + b(x);
    case "-":
      return (x) => a(x) - b(x);
    case "*":
      return (x) => a(x) * b(x);
    case "/":
      return (x) => a(x) / b(x);
    case "^":
      return (x) => a(x) ** b(x);
    default:
      throw new ExprError(`bad operator ${op}`);
  }
}
