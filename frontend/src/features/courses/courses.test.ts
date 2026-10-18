import { TutorRequest } from "@mew/shared";
import { describe, expect, it, vi } from "vitest";

import { buildTutorRequest } from "../tutor/context";
import { RecognitionService } from "../tutor/recognition";
import { formatPages, notebookHref } from "./api";

const COURSE = "11111111-1111-4111-8111-111111111111";

function context(fetchImpl: typeof fetch, courseId: string | null = COURSE) {
  return buildTutorRequest({
    intent: "answer_question",
    utterance: "why does friction slow things down?",
    transcript: [],
    previousSpeech: [],
    answerStyle: "hints_first",
    doc: null,
    recognition: new RecognitionService(fetchImpl),
    courseId,
    fetchImpl,
  });
}

describe("course context for the tutor", () => {
  it("adds the most relevant passages, with their pages, to the request", async () => {
    const fetchImpl = vi.fn<(url: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(() =>
      Promise.resolve(
        Response.json({
          chunks: [
            {
              page: 3,
              heading: "3.3 Friction",
              text: "Friction opposes sliding. ".repeat(100),
              similarity: 0.82,
              source_title: "Forces",
            },
          ],
        }),
      ),
    );
    const request = await context(fetchImpl);

    expect(fetchImpl.mock.calls[0]?.[0]).toBe(`/api/courses/${COURSE}/retrieve`);
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual({
      query: "why does friction slow things down?",
      k: 4,
    });
    expect(request.courseContext).toEqual([
      expect.objectContaining({ page: 3, heading: "3.3 Friction", source: "Forces" }),
    ]);
    expect(request.courseContext[0]?.text.length).toBeLessThanOrEqual(1200); // clipped
    expect(TutorRequest.safeParse(request).success).toBe(true);
  });

  it("answers without the material when retrieval fails or there's no course", async () => {
    const failing = vi.fn(() => Promise.reject(new Error("offline")));
    expect((await context(failing)).courseContext).toEqual([]);
    const unused = vi.fn();
    expect((await context(unused as unknown as typeof fetch, null)).courseContext).toEqual([]);
    expect(unused).not.toHaveBeenCalled();
  });
});

describe("course helpers", () => {
  it("formats page lists as ranges", () => {
    expect(formatPages([3])).toBe("p. 3");
    expect(formatPages([5, 3, 4, 9, 9])).toBe("pp. 3–5, 9");
    expect(formatPages([])).toBe("");
  });

  it("links to the course's own notebook", () => {
    expect(notebookHref({ id: COURSE, title: "Forces & motion" })).toBe(
      `/notebook?course=${COURSE}&title=Forces+%26+motion`,
    );
  });
});
