import type { ImageBlock, PdfWord } from "@mew/shared";
import { describe, expect, it } from "vitest";

import { circledBoxes, circledWords, pageHasWords, pdfFileName } from "./moments";

const image = (source: ImageBlock["source"], ocrText?: string) =>
  ({
    id: "33333333-3333-4333-8333-000000000001",
    pageId: "11111111-1111-4111-8111-111111111111",
    type: "image",
    clipId: "44444444-4444-4444-8444-000000000001",
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    ...(source && { source }),
    ...(ocrText && { ocrText }),
    createdAt: 1,
  }) as ImageBlock;

describe("a moment from a PDF that's also in neb (K8 §4.7)", () => {
  it("knows the PDF's file name from its link or its window title", () => {
    const web = image({
      app: "msedge.exe",
      url: "https://uni.example/notes/Week%203%20Kinematics.PDF#page=4",
      capturedAt: "x",
    });
    expect(pdfFileName(web)).toBe("week 3 kinematics.pdf");
    const local = image({
      app: "Acrobat.exe",
      title: "C:\\Notes\\week3.pdf - Adobe",
      capturedAt: "x",
    });
    expect(pdfFileName(local)).toBe("week3.pdf");
    expect(pdfFileName(image({ app: "Code.exe", title: "main.ts", capturedAt: "x" }))).toBeNull();
  });

  it("finds the circled words on a page, whatever the spacing and punctuation", () => {
    const circled = circledWords(image(undefined, "A ball thrown sideways — follows a parabola."));
    expect(circled).toBe("a ball thrown sideways follows a");
    expect(
      pageHasWords(
        "3.4 Projectile motion\nA ball, thrown sideways, follows a parabola.",
        circled ?? "",
      ),
    ).toBe(true);
    expect(pageHasWords("A ball is thrown", circled ?? "")).toBe(false);
    expect(circledWords(image(undefined, "x y"))).toBeNull();
  });
});

describe("the circled words on their PDF page (K8 §4.7)", () => {
  /** Words laid out left to right on lines 0.05 high, starting at `top`. */
  const lineOf = (text: string, top: number): PdfWord[] =>
    text.split(" ").map((word, i) => ({
      text: word,
      box: [0.1 + i * 0.08, top, 0.16 + i * 0.08, top + 0.04],
    }));
  const page = [
    ...lineOf("3.4 Projectile motion", 0.1),
    ...lineOf("A ball, thrown sideways, follows", 0.2),
    ...lineOf("a parabola. Its speed changes", 0.25),
    ...lineOf("Air resistance is ignored.", 0.3),
  ];

  it("finds them and boxes each line they're on, past a misread word", () => {
    // "parabola" read as "parabo1a" on screen: still followed to the end of the sentence.
    const boxes = circledBoxes(page, "A ball thrown sideways — follows a parabo1a. Its speed");
    expect(boxes).toHaveLength(2);
    expect(boxes[0]?.[1]).toBeCloseTo(0.2);
    expect(boxes[1]).toEqual([0.1, 0.25, expect.closeTo(0.4), 0.29]);
  });

  it("finds nothing when the words aren't on the page, or there are too few", () => {
    expect(circledBoxes(page, "Newton's third law says")).toEqual([]);
    expect(circledBoxes(page, "a ball")).toEqual([]);
  });
});
