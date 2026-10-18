import { FONT_METRICS } from "../glyphs/font";
import { type Box, drawn, EMPTY, glyphBox, hbox, type Mark, placed, space } from "./box";
import { LatexError, latexToPlainText, type MathNode, parseLatex } from "./latex-parse";
import { typesetText } from "./text";

const SCRIPT_SCALE = 0.7;
const FRACTION_SCALE = 0.85;
const MIN_SCALE = 0.45;

export type MathLayout = {
  box: Box;
  /** Characters the font couldn't draw (skipped). */
  missing: string[];
  /** True when the LaTeX couldn't be parsed and was written as plain text instead. */
  fellBack: boolean;
};

/**
 * Typesets LaTeX as ink-ready marks (x-height units, baseline at y = 0). Unsupported input falls
 * back to plain text rather than failing.
 */
export function typesetLatex(latex: string, { maxWidth = Infinity } = {}): MathLayout {
  const missing = new Set<string>();
  try {
    const box = layout(parseLatex(latex), 1, missing);
    return { box, missing: [...missing], fellBack: false };
  } catch (error) {
    if (!(error instanceof LatexError)) throw error;
    const text = typesetText(latexToPlainText(latex), { maxWidth });
    return { box: text.box, missing: text.missing, fellBack: true };
  }
}

function layout(node: MathNode, s: number, missing: Set<string>): Box {
  switch (node.k) {
    case "sym":
      return symbol(node.c, s, missing);
    case "text": {
      const text = typesetText(node.s, { scale: s });
      text.missing.forEach((c) => missing.add(c));
      // Keep surrounding spaces of \text{ and } as visible gaps.
      const lead = /^\s/.test(node.s) ? 0.5 * s : 0;
      const trail = /\s$/.test(node.s) ? 0.5 * s : 0;
      return hbox([space(lead), text.box, space(trail)]);
    }
    case "row":
      return hbox(node.items.map((item) => layout(item, s, missing)));
    case "space":
      return space(node.w * s);
    case "frac":
      return fraction(node.num, node.den, s, missing);
    case "sqrt":
      return radical(node.body, node.index, s, missing);
    case "scripts":
      return scripts(node, s, missing);
    case "accent":
      return accent(node.kind, layout(node.body, s, missing), s);
    case "bigop":
      return bigOperator(node.c, s, missing);
  }
}

function symbol(chars: string, s: number, missing: Set<string>): Box {
  const boxes: Box[] = [];
  for (const ch of chars) {
    const box = glyphBox(ch, s);
    if (box) boxes.push(box);
    else missing.add(ch);
  }
  return hbox(boxes);
}

function scaleFor(s: number, factor: number): number {
  return Math.max(MIN_SCALE, s * factor);
}

function scripts(node: Extract<MathNode, { k: "scripts" }>, s: number, missing: Set<string>): Box {
  const big = node.base.k === "bigop" && node.base.c !== "∫";
  const base = layout(node.base, s, missing);
  const ss = scaleFor(s, SCRIPT_SCALE);
  const sup = node.sup ? layout(node.sup, ss, missing) : null;
  const sub = node.sub ? layout(node.sub, ss, missing) : null;

  if (big) {
    // ∑ and ∏ take their limits above and below.
    const width = Math.max(base.width, sup?.width ?? 0, sub?.width ?? 0);
    const gap = 0.2 * s;
    const marks: Mark[] = [...placed(base, (width - base.width) / 2, 0)];
    let ascent = base.ascent;
    let descent = base.descent;
    if (sup) {
      const y = -base.ascent - gap - sup.descent;
      marks.push(...placed(sup, (width - sup.width) / 2, y));
      ascent = -y + sup.ascent;
    }
    if (sub) {
      const y = base.descent + gap + sub.ascent;
      marks.push(...placed(sub, (width - sub.width) / 2, y));
      descent = y + sub.descent;
    }
    return { width: width + 0.15 * s, ascent, descent, marks };
  }

  const x = base.width + 0.06 * s;
  let supY = sup ? -Math.max(0.75 * s, base.ascent - 0.45 * sup.ascent) : 0;
  let subY = sub ? Math.max(0.3 * s, base.descent + 0.1 * s) : 0;
  if (sup && sub) {
    // Keep a clear gap between the two scripts.
    const clash = supY + sup.descent + 0.15 * s - (subY - sub.ascent);
    if (clash > 0) {
      supY -= clash / 2;
      subY += clash / 2;
    }
  }
  const marks: Mark[] = [...base.marks];
  if (sup) marks.push(...placed(sup, x, supY));
  if (sub) marks.push(...placed(sub, x, subY));
  return {
    width: x + Math.max(sup?.width ?? 0, sub?.width ?? 0) + 0.06 * s,
    ascent: Math.max(base.ascent, sup ? -supY + sup.ascent : 0),
    descent: Math.max(base.descent, sub ? subY + sub.descent : 0),
    marks,
  };
}

function fraction(num: MathNode, den: MathNode, s: number, missing: Set<string>): Box {
  const fs = scaleFor(s, FRACTION_SCALE);
  const top = layout(num, fs, missing);
  const bottom = layout(den, fs, missing);
  const pad = 0.15 * s;
  const gap = 0.3 * s;
  const axis = FONT_METRICS.axis * s;
  const barWidth = Math.max(top.width, bottom.width) + 2 * pad;
  const topY = -axis - gap - top.descent;
  const bottomY = -axis + gap + bottom.ascent;
  const side = 0.12 * s;
  const bar = drawn([[side, -axis, side + barWidth, -axis]], { width: 0, ascent: 0, descent: 0 });
  return {
    width: barWidth + 2 * side,
    ascent: -topY + top.ascent,
    descent: bottomY + bottom.descent,
    marks: [
      ...placed(top, side + (barWidth - top.width) / 2, topY),
      ...bar.marks,
      ...placed(bottom, side + (barWidth - bottom.width) / 2, bottomY),
    ],
  };
}

function radical(
  bodyNode: MathNode,
  indexNode: MathNode | undefined,
  s: number,
  missing: Set<string>,
): Box {
  const body = layout(bodyNode, s, missing);
  const ascent = Math.max(body.ascent, 1 * s) + 0.3 * s;
  const descent = Math.max(body.descent, 0.05 * s) + 0.1 * s;
  const height = ascent + descent;
  const index = indexNode ? layout(indexNode, scaleFor(s, 0.5), missing) : null;
  const lead = index ? Math.max(0, index.width - 0.2 * s) : 0;

  // Check-mark radical: a short tick down into the V, a long rise, then the bar over the body.
  const tickX = lead;
  const tickY = descent - 0.5 * height;
  const vX = lead + 0.3 * s;
  const riseX = lead + 0.65 * s;
  const bodyX = riseX + 0.12 * s;
  const end = bodyX + body.width + 0.12 * s;
  const sign = drawn([[tickX, tickY, vX, descent, riseX, -ascent, end, -ascent]], {
    width: 0,
    ascent: 0,
    descent: 0,
  });
  const marks: Mark[] = [...sign.marks, ...placed(body, bodyX, 0)];
  let top = ascent;
  if (index) {
    const y = tickY - 0.15 * s - index.descent;
    marks.push(...placed(index, 0, y));
    top = Math.max(top, -y + index.ascent);
  }
  return { width: end + 0.1 * s, ascent: top, descent, marks };
}

function accent(kind: "vec" | "bar" | "hat" | "dot", body: Box, s: number): Box {
  const y = -(Math.max(body.ascent, 1 * s) + 0.25 * s);
  const x0 = 0.08 * body.width;
  const x1 = body.width - 0.08 * body.width;
  const mid = body.width / 2;
  const h = 0.2 * s;
  const strokes: number[][] = {
    vec: [
      [x0, y, x1, y],
      [x1 - h, y - h, x1, y, x1 - h, y + h],
    ],
    bar: [[x0, y, x1, y]],
    hat: [[mid - 1.5 * h, y + h, mid, y - h / 2, mid + 1.5 * h, y + h]],
    dot: [[mid, y, mid + 0.04 * s, y + 0.04 * s]],
  }[kind];
  const mark = drawn(strokes, { width: 0, ascent: 0, descent: 0 });
  return { ...body, ascent: -y + h, marks: [...body.marks, ...mark.marks] };
}

/** ∑ ∏ ∫ drawn larger and centred on the maths axis. */
function bigOperator(c: string, s: number, missing: Set<string>): Box {
  const scale = (c === "∫" ? 1.15 : 1.05) * s;
  const box = glyphBox(c, scale);
  if (!box) {
    missing.add(c);
    return EMPTY;
  }
  const centre = (box.descent - box.ascent) / 2;
  const dy = -FONT_METRICS.axis * s - centre;
  return {
    width: box.width,
    ascent: box.ascent - dy,
    descent: Math.max(0, box.descent + dy),
    marks: placed(box, 0, dy),
  };
}
