import { describe, expect, it } from "vitest";

import { lineContentHash } from "./hash";
import { assignLineIds, type KnownLine, type SegmentedLine } from "./line-identity";
import { strokeThrough } from "./test-helpers";
import { seededRandom } from "./tutor/random";

function counter(prefix = "new"): () => string {
  let n = 0;
  return () => `${prefix}-${++n}`;
}

function line(strokeIds: string[], firstCreatedAt = 0): SegmentedLine {
  return { strokeIds, firstCreatedAt };
}

function ids(result: ReturnType<typeof assignLineIds>): string[] {
  return result.lines.map((l) => l.id);
}

describe("assignLineIds", () => {
  const known: KnownLine[] = [
    { id: "A", strokeIds: ["a1", "a2", "a3", "a4"] },
    { id: "B", strokeIds: ["b1", "b2"] },
  ];

  it("keeps every id when nothing changed", () => {
    const result = assignLineIds(
      known,
      [line(["a1", "a2", "a3", "a4"]), line(["b1", "b2"])],
      counter(),
    );
    expect(ids(result)).toEqual(["A", "B"]);
    expect(result.removed).toEqual([]);
  });

  it("keeps the id of a line that was extended or partly erased", () => {
    const extended = assignLineIds(known, [line(["a1", "a2", "a3", "a4", "a5", "a6"])], counter());
    expect(ids(extended)).toEqual(["A"]);
    const halfErased = assignLineIds(known, [line(["a1", "a2"])], counter());
    expect(ids(halfErased)).toEqual(["A"]);
  });

  it("gives a new id once less than half of the earlier strokes remain", () => {
    const result = assignLineIds(known, [line(["a1", "x1", "x2"])], counter());
    expect(ids(result)).toEqual(["new-1"]);
    expect(result.removed).toEqual(["A", "B"]);
  });

  it("keeps the id on the larger part of a split line", () => {
    const result = assignLineIds(known, [line(["a4"], 2), line(["a1", "a2", "a3"], 1)], counter());
    expect(ids(result)).toEqual(["new-1", "A"]);
  });

  it("keeps one id when two lines merge, and reports the other as removed", () => {
    const result = assignLineIds(known, [line(["a1", "a2", "a3", "a4", "b1", "b2"])], counter());
    expect(ids(result)).toEqual(["A"]);
    expect(result.removed).toEqual(["B"]);
  });

  it("breaks ties in favour of the line written first", () => {
    const even: KnownLine[] = [{ id: "E", strokeIds: ["e1", "e2"] }];
    const result = assignLineIds(even, [line(["e2"], 9), line(["e1"], 3)], counter());
    expect(ids(result)).toEqual(["new-1", "E"]);
  });

  it("reports every earlier line as removed when the page is cleared", () => {
    const result = assignLineIds(known, [], counter());
    expect(result).toEqual({ lines: [], removed: ["A", "B"] });
  });

  it("holds its invariants on random edits", () => {
    const random = seededRandom(42);
    for (let round = 0; round < 300; round++) {
      // A random page of lines, then a random edit: strokes erased, added, and moved between lines.
      const before: KnownLine[] = Array.from({ length: 1 + Math.floor(random() * 6) }, (_, i) => ({
        id: `L${i}`,
        strokeIds: Array.from({ length: 1 + Math.floor(random() * 8) }, (_, j) => `s${i}-${j}`),
      }));
      const strokes = before.flatMap((l) => l.strokeIds).filter(() => random() > 0.2);
      strokes.push(...Array.from({ length: Math.floor(random() * 5) }, (_, i) => `added-${i}`));
      const groups = new Map<number, string[]>();
      for (const stroke of strokes) {
        const target = Math.floor(random() * (before.length + 1));
        groups.set(target, [...(groups.get(target) ?? []), stroke]);
      }
      const current = [...groups].map(([target, group]) => line(group, target));

      const result = assignLineIds(before, current, counter());
      const given = ids(result);
      // Ids are unique; every earlier id is either kept once or reported removed, never both.
      expect(new Set(given).size).toBe(given.length);
      const kept = given.filter((id) => id.startsWith("L"));
      expect([...kept, ...result.removed].sort()).toEqual(before.map((l) => l.id).sort());
      // A kept id always sits on a line holding at least half of that id's earlier strokes.
      for (const { line: l, id } of result.lines) {
        const earlier = before.find((k) => k.id === id);
        if (!earlier) continue;
        const shared = l.strokeIds.filter((s) => earlier.strokeIds.includes(s)).length;
        expect(shared * 2).toBeGreaterThanOrEqual(earlier.strokeIds.length);
      }
      // The same input always gives the same answer.
      expect(ids(assignLineIds(before, current, counter()))).toEqual(given);
    }
  });
});

describe("lineContentHash", () => {
  const a = strokeThrough([
    [0, 0],
    [10, 0],
  ]);
  const b = strokeThrough([
    [0, 9],
    [10, 9],
    [20, 9],
  ]);

  it("ignores order and moves, but notices added, erased or different strokes", () => {
    const moved = { ...a, bbox: [50, 50, 10, 2] as [number, number, number, number] };
    expect(lineContentHash([a, b])).toBe(lineContentHash([b, a]));
    expect(lineContentHash([moved, b])).toBe(lineContentHash([a, b]));
    expect(lineContentHash([a])).not.toBe(lineContentHash([a, b]));
    expect(lineContentHash([a, { ...b, points: b.points.slice(1) }])).not.toBe(
      lineContentHash([a, b]),
    );
    expect(lineContentHash([a, b])).toMatch(/^[0-9a-f]{8}$/);
  });
});
