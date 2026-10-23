import { describe, expect, it } from "vitest";

import { type LocalNoteLine, syncKey } from "./local-lines";
import { afterSync, needsSync, type PageRef, planSync } from "./sync-plan";
import { ids, PAGE_ID, recognised } from "./test-helpers";

const PAGE: PageRef = {
  notebook: { id: "11111111-1111-4111-8111-111111111111", title: "Biology", courseId: null },
  pageIndex: 2,
};

const nextId = ids();

function record(overrides: Partial<LocalNoteLine> = {}): LocalNoteLine {
  return {
    id: nextId(),
    pageId: PAGE_ID,
    source: "ink",
    strokeIds: ["s1"],
    bbox: [10.04, 20, 200, 24],
    lineIndex: 0,
    contentHash: "0a1b2c3d",
    recognition: recognised("enzymes lower activation energy"),
    synced: "",
    removed: false,
    ...overrides,
  };
}

describe("planSync", () => {
  it("sends a recognised line once, then nothing until it changes", () => {
    const line = record();
    const [batch, ...more] = planSync([line], PAGE);
    expect(more).toEqual([]);
    expect(batch?.body).toEqual({
      ...PAGE,
      upsert: [
        {
          id: line.id,
          lineIndex: 0,
          bbox: [10, 20, 200, 24],
          source: "ink",
          text: "enzymes lower activation energy",
          latex: null,
          confidence: 0.9,
          contentHash: "0a1b2c3d",
        },
      ],
      remove: [],
    });

    const { save, drop } = afterSync([line], batch!.sent);
    expect(drop).toEqual([]);
    expect(planSync(save, PAGE)).toEqual([]);
    expect(needsSync(save)).toBe(false);
    expect(needsSync([{ ...save[0]!, lineIndex: 4 }])).toBe(true);
  });

  it("never sends a blank or unrecognised line, and withdraws one the server has", () => {
    expect(
      planSync([record({ recognition: recognised("", 0) }), record({ recognition: null })], PAGE),
    ).toEqual([]);
    const changed = record({ recognition: null, synced: "something" });
    const [batch] = planSync([changed], PAGE);
    expect(batch?.body.upsert).toEqual([]);
    expect(batch?.body.remove).toEqual([changed.id]);
  });

  it("removes a line that's gone, then forgets it", () => {
    const gone = record({ removed: true, synced: "something" });
    const [batch] = planSync([gone], PAGE);
    expect(batch?.body.remove).toEqual([gone.id]);
    expect(afterSync([gone], batch!.sent)).toEqual({ save: [], drop: [gone.id] });
  });

  it("doesn't mark a line synced if it changed while the request was out", () => {
    const line = record();
    const [batch] = planSync([line], PAGE);
    const edited = { ...line, recognition: recognised("edited") };
    expect(afterSync([edited], batch!.sent).save).toEqual([]);
    expect(planSync([edited], PAGE)).toHaveLength(1);
  });

  it("splits a big page into requests within the limits", () => {
    const lines = Array.from({ length: 450 }, (_, i) => record({ lineIndex: i }));
    const batches = planSync(lines, PAGE);
    expect(batches.map((b) => b.body.upsert.length)).toEqual([200, 200, 50]);
    expect(new Set(batches.flatMap((b) => [...b.sent.keys()])).size).toBe(450);
  });

  it("keys a line on everything the server stores about it", () => {
    const line = record();
    expect(syncKey({ ...line, bbox: [10.01, 20, 200, 24] })).toBe(syncKey(line)); // rounding
    for (const change of [
      { lineIndex: 3 },
      { contentHash: "ffffffff" },
      { bbox: [11, 20, 200, 24] as LocalNoteLine["bbox"] },
    ]) {
      expect(syncKey({ ...line, ...change })).not.toBe(syncKey(line));
    }
  });
});
