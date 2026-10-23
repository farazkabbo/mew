import { describe, expect, it } from "vitest";

import { ClipCreateRequest, ClipUrl } from "./clips";

const CLIP = {
  image: { jpeg: "/9j/4AAQ", width: 1200, height: 600 },
  pixelRatio: 1.5,
  strokes: [
    {
      tool: "pen",
      color: "#8a7bf0",
      width: 3,
      points: [
        [10, 10, 0.5, 0],
        [20, 12, 0.5, 16],
      ],
    },
  ],
  source: {
    app: "msedge.exe",
    title: "Physics worksheet 3",
    url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=754",
    timestampSec: 754,
    capturedAt: "2026-10-22T10:00:00.000Z",
  },
  ocrText: "Question 3. A 2 kg block…",
} as const;

describe("clip schemas", () => {
  it("accepts a clip with the tutor's strokes and its source", () => {
    expect(ClipCreateRequest.parse(CLIP).strokes).toHaveLength(1);
  });

  it.each([
    "https://example.com/notes/week-3",
    "https://www.youtube.com/watch?v=abc",
    "https://youtube.com/watch?v=abc&t=12",
    "https://youtu.be/abc?t=3",
  ])("stores trimmed links like %s", (url) => {
    expect(ClipUrl.safeParse(url).success).toBe(true);
  });

  it.each([
    ["http://example.com/", "not https"],
    ["https://example.com/?session=secret", "a query string"],
    ["https://example.com/#access_token=x", "a fragment"],
    ["https://user:pass@example.com/", "credentials"],
    ["https://www.youtube.com/watch?v=abc&si=tracking", "an unknown YouTube parameter"],
    ["javascript:alert(1)", "a script"],
    ["https://localhost/", "no real domain"],
  ])("refuses %s (%s)", (url) => {
    expect(ClipUrl.safeParse(url).success).toBe(false);
  });

  it("refuses control characters in text the page will show", () => {
    const bad = { ...CLIP, source: { ...CLIP.source, title: "Title\u0007" } };
    expect(ClipCreateRequest.safeParse(bad).success).toBe(false);
    expect(ClipCreateRequest.safeParse({ ...CLIP, ocrText: "a\u0000b" }).success).toBe(false);
    expect(ClipCreateRequest.safeParse({ ...CLIP, ocrText: "line one\nline two" }).success).toBe(
      true,
    );
  });

  it("refuses images over the size cap and paths for the app", () => {
    const big = { ...CLIP, image: { ...CLIP.image, width: 2401 } };
    expect(ClipCreateRequest.safeParse(big).success).toBe(false);
    const path = { ...CLIP, source: { ...CLIP.source, app: "C:\\x\\msedge.exe" } };
    expect(ClipCreateRequest.safeParse(path).success).toBe(false);
  });
});
