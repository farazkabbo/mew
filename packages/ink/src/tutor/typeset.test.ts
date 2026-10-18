import { describe, expect, it } from "vitest";

import { FONT_METRICS, glyph, hasGlyph } from "./glyphs/font";
import { type Box, pointCount } from "./typeset/box";
import { typesetLatex } from "./typeset/latex-layout";
import { LatexError, latexToPlainText, type MathNode, parseLatex } from "./typeset/latex-parse";
import { LINE_LEADING, typesetText } from "./typeset/text";

/** Vertical extent [top, bottom] of all ink in a box (y down). */
function inkExtent(box: Box): [number, number] {
  const ys = box.marks.flatMap((m) => m.strokes.flatMap((s) => s.filter((_, i) => i % 2 === 1)));
  return [Math.min(...ys), Math.max(...ys)];
}

describe("glyph font", () => {
  it("has every character the brief asks for", () => {
    const required =
      "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.,;:!?'\"()[]{}+-=<>/" +
      "+−×÷=≠≈≤≥√∫Σ∑πθλΔ→⇌°±∞∂·";
    expect(Array.from(required).filter((c) => !hasGlyph(c))).toEqual([]);
  });

  it("uses x-height units with the baseline at 0", () => {
    const x = glyph("x");
    const ys = x?.strokes.flatMap((s) => s.filter((_, i) => i % 2 === 1)) ?? [];
    expect(Math.min(...ys)).toBeCloseTo(-1); // top of a lowercase x
    expect(Math.max(...ys)).toBeCloseTo(0); // sits on the baseline
    expect(FONT_METRICS.capHeight).toBeCloseTo(1.5);
  });

  it("aliases look-alike characters and rejects unknown ones", () => {
    expect(glyph("−")).toBe(glyph("-"));
    expect(glyph("😀")).toBeUndefined();
  });
});

describe("text layout", () => {
  it("wraps at spaces to stay within the width", () => {
    const { box } = typesetText("the quick brown fox jumps over the lazy dog", { maxWidth: 12 });
    expect(box.width).toBeLessThanOrEqual(12);
    expect(box.descent).toBeGreaterThan(LINE_LEADING); // more than one line
  });

  it("reports characters it can't draw instead of failing", () => {
    const { box, missing } = typesetText("hi 😀 there");
    expect(missing).toEqual(["😀"]);
    expect(box.marks.length).toBeGreaterThan(0);
  });
});

describe("LaTeX parsing", () => {
  it("parses fractions, scripts, roots and symbols", () => {
    const node = parseLatex("\\frac{a^2}{b_1} + \\sqrt[3]{x} \\le \\pi");
    expect(node.k).toBe("row");
    const items = (node as Extract<MathNode, { k: "row" }>).items;
    expect(items[0]).toMatchObject({ k: "frac", num: { k: "scripts" }, den: { k: "scripts" } });
    expect(items).toContainEqual(
      expect.objectContaining({ k: "sqrt", index: { k: "sym", c: "3" } }),
    );
    expect(items).toContainEqual({ k: "sym", c: "≤" });
    expect(items.at(-1)).toEqual({ k: "sym", c: "π" });
  });

  it("accepts single-token arguments and math delimiters", () => {
    expect(parseLatex("$\\frac12$")).toMatchObject({ k: "frac", num: { c: "1" }, den: { c: "2" } });
    expect(parseLatex("\\(x^2\\)")).toMatchObject({ k: "scripts", sup: { c: "2" } });
  });

  it("keeps \\text contents (with spaces) and function names upright", () => {
    expect(parseLatex("\\text{if } x")).toMatchObject({ items: [{ k: "text", s: "if " }, {}] });
    expect(parseLatex("\\sin x")).toMatchObject({ items: [{ k: "text", s: "sin" }, {}] });
  });

  it("rejects what it doesn't understand", () => {
    expect(() => parseLatex("\\begin{matrix}")).toThrow(LatexError);
    expect(() => parseLatex("{x")).toThrow(LatexError);
    expect(() => parseLatex("x}")).toThrow(LatexError);
  });

  it("caps nesting depth and size (model output is untrusted)", () => {
    expect(() => parseLatex(`${"{".repeat(40)}x${"}".repeat(40)}`)).toThrow(/deeply/);
    expect(() => parseLatex("x+".repeat(300))).toThrow(/too large/);
  });

  it("degrades to readable plain text", () => {
    expect(latexToPlainText("\\frac{a}{b} \\cdot \\sqrt{x} \\to \\infty")).toBe(
      "(a)/(b) · √(x) → ∞",
    );
  });
});

describe("LaTeX layout", () => {
  it("raises superscripts and lowers subscripts", () => {
    const sup = typesetLatex("x^2").box;
    const sub = typesetLatex("x_2").box;
    const plain = typesetLatex("x").box;
    expect(sup.ascent).toBeGreaterThan(plain.ascent);
    expect(sub.descent).toBeGreaterThan(plain.descent);
    expect(sup.width).toBeGreaterThan(plain.width);
  });

  it("stacks fractions around the maths axis", () => {
    const { box } = typesetLatex("\\frac{1}{2}");
    const [top, bottom] = inkExtent(box);
    const axis = -FONT_METRICS.axis;
    expect(top).toBeLessThan(axis - 0.5); // numerator above the bar
    expect(bottom).toBeGreaterThan(axis + 0.5); // denominator below it
    const bar = box.marks.find((m) => m.strokes.some((s) => s.length === 4 && s[1] === s[3]));
    expect(bar?.strokes[0]?.[1]).toBeCloseTo(axis);
  });

  it("draws a radical over its whole body", () => {
    const narrow = typesetLatex("\\sqrt{x}").box;
    const wide = typesetLatex("\\sqrt{x+y+z}").box;
    expect(wide.width - narrow.width).toBeGreaterThan(2);
  });

  it("falls back to plain text for unsupported LaTeX", () => {
    const result = typesetLatex("\\unknowncommand{x} = 2");
    expect(result.fellBack).toBe(true);
    expect(result.box.marks.length).toBeGreaterThan(0);
  });

  it("keeps a short equation compact", () => {
    const { box, missing, fellBack } = typesetLatex("F_1 = -F_2");
    expect(fellBack).toBe(false);
    expect(missing).toEqual([]);
    expect(box.width).toBeLessThan(12);
    expect(pointCount(box)).toBeLessThan(200);
  });
});
