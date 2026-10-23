import { describe, expect, it } from "vitest";

import { NotePageSync, NoteLineUpsert } from "./notes";
import { Recognition, RecognizeBatchRequest } from "./tutor";

const line = {
  id: "33333333-3333-4333-8333-333333333333",
  lineIndex: 0,
  bbox: [10, 20, 200, 24],
  source: "ink",
  text: "enzymes lower activation energy",
  latex: null,
  confidence: 0.9,
  contentHash: "0a1b2c3d",
};

describe("note line schemas", () => {
  it("accepts an ink line and a clip line that names its clip", () => {
    expect(NoteLineUpsert.safeParse(line).success).toBe(true);
    const clip = { ...line, source: "clip", clipId: "77777777-7777-4777-8777-777777777777" };
    expect(NoteLineUpsert.safeParse(clip).success).toBe(true);
  });

  it.each([
    ["a clip line without its clip", { ...line, source: "clip" }],
    ["an ink line naming a clip", { ...line, clipId: "77777777-7777-4777-8777-777777777777" }],
    ["blank text", { ...line, text: "   " }],
    ["over-long text", { ...line, text: "x".repeat(301) }],
    ["a malformed hash", { ...line, contentHash: "XYZ" }],
    ["a confidence above 1", { ...line, confidence: 1.2 }],
  ])("refuses %s", (_, candidate) => {
    expect(NoteLineUpsert.safeParse(candidate).success).toBe(false);
  });

  it("caps a sync at 200 lines", () => {
    const sync = {
      notebook: { id: "11111111-1111-4111-8111-111111111111", title: "Bio", courseId: null },
      pageIndex: 0,
      upsert: Array.from({ length: 201 }, () => line),
      remove: [],
    };
    expect(NotePageSync.safeParse(sync).success).toBe(false);
    expect(NotePageSync.safeParse({ ...sync, upsert: [line] }).success).toBe(true);
  });
});

describe("recognition schemas", () => {
  it("requires a confidence between 0 and 1", () => {
    const base = { text: "x = 2", latex: "x = 2", subject: "math" };
    expect(Recognition.safeParse(base).success).toBe(false);
    expect(Recognition.safeParse({ ...base, confidence: 0.7 }).success).toBe(true);
    expect(Recognition.safeParse({ ...base, confidence: -0.1 }).success).toBe(false);
  });

  it("takes one to eight lines per batch", () => {
    expect(RecognizeBatchRequest.safeParse({ images: [] }).success).toBe(false);
    expect(RecognizeBatchRequest.safeParse({ images: Array(8).fill("a") }).success).toBe(true);
    expect(RecognizeBatchRequest.safeParse({ images: Array(9).fill("a") }).success).toBe(false);
  });
});
