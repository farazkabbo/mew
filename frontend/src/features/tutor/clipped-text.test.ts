import type { ImageBlock } from "@mew/shared";
import { describe, expect, it } from "vitest";

import { clippedText } from "./context";

const image = (createdAt: number, ocrText?: string, title?: string): ImageBlock => ({
  id: crypto.randomUUID(),
  pageId: crypto.randomUUID(),
  type: "image",
  clipId: crypto.randomUUID(),
  x: 0,
  y: 0,
  width: 100,
  height: 50,
  source: { app: "acrobat.exe", capturedAt: "2026-10-22T10:00:00Z", ...(title && { title }) },
  ...(ocrText !== undefined && { ocrText }),
  createdAt,
});

describe("clipped text for the tutor", () => {
  it("gives the newest clips' text with where it came from, and skips clips without text", () => {
    const context = clippedText([
      image(1, "Old question"),
      image(3, "Question 3. A 2 kg block", "Worksheet.pdf"),
      image(2, "   "),
      image(4),
      image(5, "Newest slide"),
    ]);
    expect(context).toEqual([
      { source: "acrobat", text: "Newest slide" },
      { source: "Worksheet.pdf", text: "Question 3. A 2 kg block" },
    ]);
  });

  it("caps how much of a clip's text is sent", () => {
    const [only] = clippedText([image(1, "x".repeat(9000))]);
    expect(only?.text).toHaveLength(4000);
  });
});
