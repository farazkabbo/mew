import type { BBox } from "@mew/shared";
import { describe, expect, it } from "vitest";

import { snapLine, snapPoint, snapRegion } from "./snap";

/** Three lines of four 100×24 words, 40 px apart, starting at (100, 100). */
const WORDS: BBox[] = [0, 1, 2].flatMap((row) =>
  [0, 1, 2, 3].map((col): BBox => [100 + col * 110, 100 + row * 40, 100, 24]),
);

describe("snapLine", () => {
  it("moves an underline aimed half a line too high onto the line it's for", () => {
    // Line 2 is y 140–164; the model's box sits 12 px up (it would cut through the words).
    expect(snapLine([100, 128, 320, 24], WORDS)).toEqual([100, 140, 320, 24]);
  });

  it("takes the lower line when a box covers two equally", () => {
    expect(snapLine([100, 100, 430, 64], WORDS)).toEqual([100, 140, 430, 24]);
  });

  it("leaves a box away from any text alone", () => {
    expect(snapLine([900, 600, 200, 20], WORDS)).toEqual([900, 600, 200, 20]);
  });
});

describe("snapRegion", () => {
  it("fits a loose circle round the words it was meant for", () => {
    expect(snapRegion([205, 95, 215, 34], WORDS)).toEqual([210, 100, 210, 24]);
  });

  it("keeps a box round a figure with only a small label in it", () => {
    const figure: BBox = [100, 300, 400, 300];
    expect(snapRegion(figure, [...WORDS, [120, 310, 40, 20]])).toEqual(figure);
  });
});

describe("snapPoint", () => {
  it("moves a tip in the gap beside a word onto the word", () => {
    expect(snapPoint([205, 112], WORDS)).toEqual([200, 112]);
  });

  it("keeps a tip already on a word, or far from any", () => {
    expect(snapPoint([150, 110], WORDS)).toEqual([150, 110]);
    expect(snapPoint([900, 900], WORDS)).toEqual([900, 900]);
  });

  it("does nothing without words", () => {
    expect(snapPoint([5, 5], [])).toEqual([5, 5]);
  });
});
