import { type Line, PageDocument, strokeBBox } from "@mew/ink";
import type { Point, Recognition, Stroke } from "@mew/shared";
import { describe, expect, it, vi } from "vitest";

import type * as ExportLine from "../notebook/export-line";

// Rendering needs OffscreenCanvas (browser only): the page image is a stand-in.
vi.mock("../notebook/export-line", async (original) => ({
  ...(await original<typeof ExportLine>()),
  renderStrokesPng: () =>
    Promise.resolve({ blob: new Blob([new Uint8Array([1, 2, 3])]), width: 1, height: 1 }),
}));

import { studentLines } from "../notebook/export-line";
import { buildTutorRequest } from "./context";
import type { RecognitionService } from "./recognition";

let n = 0;
function stroke(x: number, y: number): Stroke {
  const points: Point[] = [
    [x, y + 24, 0.5, 0],
    [x + 8, y, 0.5, 10],
    [x + 16, y + 24, 0.5, 20],
  ];
  n++;
  return {
    id: `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`,
    pageId: "00000000-0000-4000-8000-0000000000aa",
    author: "student",
    tool: "pen",
    points,
    color: "#1d1c1a",
    width: 3,
    bbox: strokeBBox(points, 3),
    createdAt: n,
  };
}

/** Four lines written top to bottom (so the last one is the most recent). */
function page() {
  const doc = new PageDocument(
    [100, 200, 300, 400].flatMap((y) =>
      Array.from({ length: 4 }, (_, i) => stroke(100 + i * 20, y)),
    ),
  );
  const lines = [...studentLines(doc)].sort((a, b) => a.bbox[1] - b.bbox[1]);
  return { doc, lines };
}

const reading = (text: string): Recognition => ({
  text,
  latex: null,
  subject: "math",
  confidence: 0.9,
});

/** Line 1 is read already; the rest are read on request. */
function recognition(lines: readonly Line[]) {
  const texts = new Map(lines.map((line, i) => [line.id, `line ${i + 1}`]));
  return {
    cached: vi.fn((_doc: unknown, line: Line) =>
      line.id === lines[0]?.id ? reading("line 1") : undefined,
    ),
    recognize: vi.fn((_doc: unknown, line: Line) =>
      Promise.resolve(reading(texts.get(line.id) ?? "")),
    ),
  };
}

const request = (doc: PageDocument, service: ReturnType<typeof recognition>, circled?: Line[]) =>
  buildTutorRequest({
    intent: "answer_question",
    utterance: "what does this do?",
    transcript: [],
    previousSpeech: [],
    answerStyle: "hints_first",
    doc,
    recognition: service as unknown as RecognitionService,
    circled: circled ?? null,
  });

describe("what the tutor sees (K6 §6.3: circling your own writing)", () => {
  it("is about the circled lines, top to bottom, reading the ones not read yet", async () => {
    const { doc, lines } = page();
    const service = recognition(lines);
    const [first, , third] = lines;
    if (!first || !third) throw new Error("expected lines");

    const result = await request(doc, service, [third, first]);

    expect(result.circled).toBe(true);
    expect(result.recognizedLines).toEqual([
      { lineId: first.id, text: "line 1", latex: null },
      { lineId: third.id, text: "line 3", latex: null },
    ]);
    expect(service.recognize).toHaveBeenCalledTimes(1); // line 1 was known
    expect(result.pageImage).not.toBeNull();
  });

  it("without a circle, is about the latest lines it has already read", async () => {
    const { doc, lines } = page();
    const service = recognition(lines);

    const result = await request(doc, service);

    expect(result.circled).toBe(false);
    // Lines 2–4 are the latest; none is read yet, so they're asked for, for next time.
    expect(result.recognizedLines).toEqual([]);
    expect(service.recognize).toHaveBeenCalledTimes(3);
  });
});
