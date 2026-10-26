import type { BBox } from "@mew/shared";
import { describe, expect, it } from "vitest";

import { programFrom, sameOutput } from "./code";

/** A handwritten line starting at `x` (lines are 40 units high). */
const at = (x: number, y: number, text: string) => ({ text, bbox: [x, y, 300, 40] as BBox });

describe("programFrom", () => {
  it("indents each line by where it starts, a level per step to the right", () => {
    const program = programFrom([
      at(100, 0, "for i in range(3):"),
      at(148, 50, "if i > 0:"),
      at(196, 100, "print(i)"),
      at(104, 150, "print('done')"),
    ]);
    expect(program).toBe(
      ["for i in range(3):", "    if i > 0:", "        print(i)", "print('done')"].join("\n"),
    );
  });

  it("keeps lines that start a little apart on one level, and makes quotes plain", () => {
    const program = programFrom([at(100, 0, "  x = 2"), at(112, 50, "print(“x”, x)")]);
    expect(program).toBe('x = 2\nprint("x", x)');
  });
});

describe("sameOutput", () => {
  it("compares line by line, ignoring trailing spaces and blank ends", () => {
    expect(sameOutput("6  \n", "6")).toBe(true);
    expect(sameOutput("1\r\n2\n", "1\n2")).toBe(true);
    expect(sameOutput("1\n2", "1 2")).toBe(false);
    expect(sameOutput("", "6")).toBe(false);
  });
});
