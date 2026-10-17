import { describe, expect, it } from "vitest";

import {
  bboxesIntersect,
  bboxOfPoints,
  distanceToSegment,
  horizontalGap,
  median,
  segmentDistance,
  unionBBox,
} from "./geometry";

describe("geometry", () => {
  it("computes a padded bounding box", () => {
    expect(
      bboxOfPoints(
        [
          [1, 2, 0.5, 0],
          [5, 8, 0.5, 1],
        ],
        1,
      ),
    ).toEqual([0, 1, 6, 8]);
  });

  it("returns an empty box for no points", () => {
    expect(bboxOfPoints([])).toEqual([0, 0, 0, 0]);
  });

  it("unions boxes", () => {
    expect(unionBBox([0, 0, 2, 2], [5, -1, 1, 1])).toEqual([0, -1, 6, 3]);
  });

  it("treats touching boxes as intersecting and separated ones as not", () => {
    expect(bboxesIntersect([0, 0, 2, 2], [2, 2, 1, 1])).toBe(true);
    expect(bboxesIntersect([0, 0, 2, 2], [2.01, 0, 1, 1])).toBe(false);
  });

  it("measures horizontal gaps", () => {
    expect(horizontalGap([0, 0, 10, 10], [15, 50, 5, 5])).toBe(5);
    expect(horizontalGap([0, 0, 10, 10], [5, 50, 5, 5])).toBe(0);
  });

  it("measures point-to-segment distance, including past the endpoints", () => {
    expect(distanceToSegment([5, 3], [0, 0], [10, 0])).toBe(3);
    expect(distanceToSegment([-3, 4], [0, 0], [10, 0])).toBe(5);
    expect(distanceToSegment([3, 4], [0, 0], [0, 0])).toBe(5);
  });

  it("measures segment-to-segment distance, zero when crossing", () => {
    expect(segmentDistance([0, 0], [10, 10], [0, 10], [10, 0])).toBe(0);
    expect(segmentDistance([0, 0], [10, 0], [0, 4], [10, 4])).toBe(4);
  });

  it("computes medians", () => {
    expect(median([])).toBe(0);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });
});
