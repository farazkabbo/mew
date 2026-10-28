import { PageDocument, strokeBBox } from "@mew/ink";
import type { Point, Stroke } from "@mew/shared";
import { describe, expect, it } from "vitest";

import { studentLines } from "../notebook/export-line";
import { RecognitionService } from "./recognition";

const PAGE = "11111111-1111-4111-8111-111111111111";
let ids = 0;

/** A line of 4 zig-zag letters at height y. */
function line(y: number): Stroke[] {
  return Array.from({ length: 4 }, (_, i) => {
    const x = 100 + i * 22;
    const points: Point[] = [
      [x, y + 24, 0.5, 0],
      [x + 8, y, 0.5, 10],
      [x + 16, y + 24, 0.5, 20],
    ];
    return {
      id: `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`,
      pageId: PAGE,
      author: "student",
      tool: "pen",
      points,
      color: "#1d1c1a",
      width: 3,
      bbox: strokeBBox(points, 3),
      createdAt: ids,
    } satisfies Stroke;
  });
}

const read = (text: string, confidence = 0.9) => ({
  text,
  latex: text,
  subject: "math" as const,
  confidence,
});

describe("RecognitionService.contextFor (K10 §8.2)", () => {
  it("gives a line the 2 read lines above it, the page's first line, the subject and words", () => {
    const doc = new PageDocument([...line(100), ...line(170), ...line(240), ...line(310)]);
    const lines = studentLines(doc).sort((a, b) => a.bbox[1] - b.bbox[1]);
    const [first, second, third, fourth] = lines;
    if (!first || !second || !third || !fourth) throw new Error("lines");
    const service = new RecognitionService();
    service.remember(doc, first, read("Solve 3x + 7 = 19"));
    service.remember(doc, second, read("3x + 7 = 19"));
    service.remember(doc, third, read("3x = 12"));
    service.setReadingContext({ subject: "math", vocabulary: ["Algebra", "Linear equations"] });
    service.setCourseTerms(["Solving equations", "Algebra"]);

    expect(service.contextFor(doc, fourth)).toEqual({
      previous: ["3x + 7 = 19", "3x = 12"],
      problem: "Solve 3x + 7 = 19",
      subject: "math",
      vocabulary: ["Algebra", "Linear equations", "Solving equations"],
    });
    // The first line has no problem above it, nor previous lines.
    expect(service.contextFor(doc, first)).toMatchObject({ previous: [], problem: null });
  });

  it("leaves out lines it couldn't read", () => {
    const doc = new PageDocument([...line(100), ...line(170)]);
    const [first, second] = studentLines(doc).sort((a, b) => a.bbox[1] - b.bbox[1]);
    if (!first || !second) throw new Error("lines");
    const service = new RecognitionService();
    service.remember(doc, first, read("", 0));
    expect(service.contextFor(doc, second)).toMatchObject({ previous: [], problem: null });
  });
});
