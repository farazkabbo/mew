import { type ClipView, ImageBlock, Stroke } from "@mew/shared";
import { describe, expect, it } from "vitest";

import { clipToPage, IMAGE_ORIGIN, MAX_IMAGE_WIDTH, safeLink, sourceLabel } from "./clip-page";

const PAGE = "11111111-1111-4111-8111-111111111111";
let next = 0;
const newId = () => `00000000-0000-4000-8000-${String(++next).padStart(12, "0")}`;

const CLIP: ClipView = {
  id: "55555555-5555-4555-8555-555555555555",
  width: 900,
  height: 300,
  pixelRatio: 1.5,
  strokes: [
    {
      tool: "pen",
      color: "#8a7bf0",
      width: 3,
      points: [
        [0, 0, 0.5, 0],
        [90, 30, 0.5, 16],
      ],
    },
    { tool: "highlighter", color: "#8a7bf055", width: 30, points: [[450, 150, 0.5, 0]] },
  ],
  source: {
    app: "msedge.exe",
    title: "Lecture 5 - YouTube",
    url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=754",
    timestampSec: 754,
    capturedAt: "2026-10-22T10:00:00.000Z",
  },
  ocrText: "Question 3",
  notebookPageId: null,
  createdAt: "2026-10-22T10:00:01.000+00:00",
};

describe("a clip as a notebook page", () => {
  it("places the image at its on-screen size, with the ink on top in page units", () => {
    const { image, strokes } = clipToPage(CLIP, PAGE, { now: 1000, newId });
    // 900 image pixels at 1.5 per CSS pixel = 600 page units wide.
    expect(image).toMatchObject({
      x: IMAGE_ORIGIN[0],
      y: IMAGE_ORIGIN[1],
      width: 600,
      height: 200,
    });
    expect(ImageBlock.safeParse(image).success).toBe(true);
    const [pen, marker] = strokes;
    expect(pen?.points[1]).toEqual([IMAGE_ORIGIN[0] + 60, IMAGE_ORIGIN[1] + 20, 0.5, 16]);
    expect(pen?.width).toBeCloseTo(2);
    expect(marker?.tool).toBe("highlighter");
  });

  it("makes editable tutor ink, one group per clip", () => {
    const { strokes } = clipToPage(CLIP, PAGE, { now: 1000, newId });
    for (const stroke of strokes) {
      expect(Stroke.safeParse(stroke).success).toBe(true);
      expect(stroke.author).toBe("tutor");
      expect(stroke.pageId).toBe(PAGE);
    }
    expect(new Set(strokes.map((s) => s.groupId)).size).toBe(1);
  });

  it("never makes an image wider than the page column", () => {
    const wide = { ...CLIP, width: 2400, height: 600, pixelRatio: 1 };
    const { image } = clipToPage(wide, PAGE, { now: 0, newId });
    expect(image.width).toBe(MAX_IMAGE_WIDTH);
    expect(image.height).toBe(180);
  });

  it("labels the source and only links https", () => {
    const { image } = clipToPage(CLIP, PAGE, { now: 0, newId });
    expect(sourceLabel(image)).toBe("Lecture 5 - YouTube · 12:34");
    expect(safeLink(image.source?.url)).toBe(CLIP.source.url);
    expect(safeLink("javascript:alert(1)")).toBeNull();
    expect(safeLink("http://example.com/")).toBeNull();
    expect(safeLink("https://user:pw@example.com/")).toBeNull();
    expect(safeLink(undefined)).toBeNull();
    const untitled = clipToPage(
      { ...CLIP, source: { app: "acrobat.exe", capturedAt: CLIP.source.capturedAt } },
      PAGE,
      { now: 0, newId },
    );
    expect(sourceLabel(untitled.image)).toBe("acrobat");
  });
});
