import { describe, expect, it } from "vitest";

import { History } from "./history";
import { PageDocument } from "./page-document";
import { strokeThrough } from "./test-helpers";

describe("PageDocument", () => {
  it("lists strokes in drawing order regardless of insertion order", () => {
    const early = strokeThrough(
      [
        [0, 0],
        [10, 0],
      ],
      { createdAt: 1 },
    );
    const late = strokeThrough(
      [
        [0, 5],
        [10, 5],
      ],
      { createdAt: 2 },
    );
    const doc = new PageDocument([late, early]);

    expect(doc.all().map((s) => s.id)).toEqual([early.id, late.id]);
  });

  it("finds strokes in a region", () => {
    const left = strokeThrough([
      [0, 0],
      [10, 0],
    ]);
    const right = strokeThrough([
      [900, 0],
      [910, 0],
    ]);
    const doc = new PageDocument([left, right]);

    expect(doc.inRegion([-5, -5, 30, 30]).map((s) => s.id)).toEqual([left.id]);
  });

  it("erases only strokes the eraser path actually touches", () => {
    const horizontal = strokeThrough([
      [0, 50],
      [100, 50],
    ]);
    const nearby = strokeThrough([
      [0, 70],
      [100, 70],
    ]);
    const doc = new PageDocument([horizontal, nearby]);

    const hits = doc.hitByEraser([50, 0], [50, 55], 4);

    expect(hits.map((s) => s.id)).toEqual([horizontal.id]);
  });

  it("counts the stroke width toward eraser contact", () => {
    const thick = strokeThrough(
      [
        [0, 0],
        [100, 0],
      ],
      { width: 20 },
    );
    const doc = new PageDocument([thick]);

    expect(doc.hitByEraser([50, 14], [60, 14], 5)).toHaveLength(1);
    expect(doc.hitByEraser([50, 16], [60, 16], 5)).toHaveLength(0);
  });

  it("erases single-point dots", () => {
    const dot = strokeThrough([[10, 10]]);
    const doc = new PageDocument([dot]);

    expect(doc.hitByEraser([0, 10], [20, 10], 2)).toHaveLength(1);
  });

  it("supports undo and redo of adds and erases with drawing order intact", () => {
    const a = strokeThrough(
      [
        [0, 0],
        [10, 0],
      ],
      { createdAt: 1 },
    );
    const b = strokeThrough(
      [
        [0, 9],
        [10, 9],
      ],
      { createdAt: 2 },
    );
    const doc = new PageDocument();
    const history = new History();

    for (const command of [
      { kind: "add", strokes: [a] },
      { kind: "add", strokes: [b] },
      { kind: "erase", strokes: [a] },
    ] as const) {
      doc.apply(command);
      history.record(command);
    }
    expect(doc.all().map((s) => s.id)).toEqual([b.id]);

    const undoErase = history.undo();
    if (undoErase) doc.apply(undoErase);
    expect(doc.all().map((s) => s.id)).toEqual([a.id, b.id]);

    const redoErase = history.redo();
    if (redoErase) doc.apply(redoErase);
    expect(doc.all().map((s) => s.id)).toEqual([b.id]);
  });
});

describe("History", () => {
  it("clears redo on a new command and respects its limit", () => {
    const history = new History(2);
    const s = () => [strokeThrough([[0, 0]])];

    history.record({ kind: "add", strokes: s() });
    history.record({ kind: "add", strokes: s() });
    history.record({ kind: "add", strokes: s() });
    history.undo();
    expect(history.canRedo).toBe(true);

    history.record({ kind: "add", strokes: s() });
    expect(history.canRedo).toBe(false);

    history.undo();
    history.undo();
    expect(history.canUndo).toBe(false);
  });

  it("ignores empty commands", () => {
    const history = new History();
    history.record({ kind: "erase", strokes: [] });

    expect(history.canUndo).toBe(false);
  });
});
