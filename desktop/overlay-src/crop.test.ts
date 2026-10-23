import { describe, expect, it } from "vitest";

import { cropBetween, dragCrop, handleAt, MIN_SIZE, type Rect } from "./crop";

const FRAME: [number, number] = [1000, 800];
const CROP: Rect = [100, 100, 400, 300];

describe("crop box", () => {
  it("finds the edge, corner or inside under the pointer", () => {
    expect(handleAt(CROP, [100, 100], 6)).toBe("nw");
    expect(handleAt(CROP, [503, 398], 6)).toBe("se");
    expect(handleAt(CROP, [300, 102], 6)).toBe("n");
    expect(handleAt(CROP, [98, 250], 6)).toBe("w");
    expect(handleAt(CROP, [300, 250], 6)).toBe("move");
    expect(handleAt(CROP, [700, 700], 6)).toBe("new");
  });

  it("resizes from an edge or corner, never inside out or off the frame", () => {
    expect(dragCrop(CROP, "se", 50, 20, FRAME)).toEqual([100, 100, 450, 320]);
    expect(dragCrop(CROP, "w", -500, 0, FRAME)).toEqual([0, 100, 500, 300]);
    expect(dragCrop(CROP, "e", -1000, 0, FRAME)).toEqual([100, 100, MIN_SIZE, 300]);
    expect(dragCrop(CROP, "s", 0, 5000, FRAME)).toEqual([100, 100, 400, 700]);
  });

  it("moves the whole box but keeps it on the frame", () => {
    expect(dragCrop(CROP, "move", 30, -20, FRAME)).toEqual([130, 80, 400, 300]);
    expect(dragCrop(CROP, "move", 5000, 5000, FRAME)).toEqual([600, 500, 400, 300]);
  });

  it("draws a new box in any direction, once it's big enough", () => {
    expect(cropBetween([500, 400], [200, 100], FRAME)).toEqual([200, 100, 300, 300]);
    expect(cropBetween([10, 10], [20, 20], FRAME)).toBeNull();
    expect(cropBetween([-50, -50], [100, 100], FRAME)).toEqual([0, 0, 100, 100]);
  });
});
