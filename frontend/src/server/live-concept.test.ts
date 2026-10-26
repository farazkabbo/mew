import type { CourseDetail } from "@mew/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { liveConcept } from "./live-concept";

const COURSE = "22222222-2222-4222-8222-222222222222";
const LINEAR = "33333333-3333-4333-8333-000000000001";
const FRICTION = "33333333-3333-4333-8333-000000000002";

const detail = {
  course: { id: COURSE, title: "Algebra", status: "ready", created_at: "2026-10-01" },
  sources: [],
  concepts: [
    {
      id: LINEAR,
      course_id: COURSE,
      title: "Linear equations",
      summary: "Solve ax + b = c.",
      order_index: 0,
      source_pages: [],
    },
    {
      id: FRICTION,
      course_id: COURSE,
      title: "Friction",
      summary: "Opposes sliding.",
      order_index: 1,
      source_pages: [],
    },
  ],
  edges: [],
} as unknown as CourseDetail;

beforeEach(() => {
  vi.stubEnv("GEMINI_API_KEY", "test-key");
});

describe("which concept a right line practises (K9 §7.4)", () => {
  it("is one of the course's own concepts, never an id the model made up", async () => {
    const course = vi.fn(() => Promise.resolve(detail));
    const generate = vi.fn().mockResolvedValueOnce({ conceptId: LINEAR });
    const lines = ["3x + 7 = 19", "3x = 12"];
    expect(await liveConcept({ courseId: COURSE, lines }, { course, generate })).toBe(LINEAR);
    const sent = JSON.parse(
      (generate.mock.calls[0]?.[0] as { input: { text: string }[] }).input[0]?.text ?? "{}",
    ) as {
      lines: string[];
      concepts: { id: string }[];
    };
    expect(sent.lines).toEqual(lines);
    expect(sent.concepts.map((c) => c.id)).toEqual([LINEAR, FRICTION]);

    generate.mockResolvedValueOnce({ conceptId: "44444444-4444-4444-8444-000000000009" });
    expect(await liveConcept({ courseId: COURSE, lines }, { course, generate })).toBeNull();
    generate.mockResolvedValueOnce({ conceptId: null });
    expect(await liveConcept({ courseId: COURSE, lines }, { course, generate })).toBeNull();
  });

  it("asks nothing when the course has no concepts yet", async () => {
    const generate = vi.fn();
    const empty = { ...detail, concepts: [] } as unknown as CourseDetail;
    expect(
      await liveConcept(
        { courseId: COURSE, lines: ["x = 4"] },
        { course: () => Promise.resolve(empty), generate },
      ),
    ).toBeNull();
    expect(generate).not.toHaveBeenCalled();
  });
});
