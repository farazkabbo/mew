import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Learner model and quiz routes (M8), in local mode (no Clerk keys), as in development. */
const ORIGIN = "http://localhost:3000";
const COURSE = "22222222-2222-4222-8222-222222222222";
const CONCEPT = "33333333-3333-4333-8333-333333333333";
const params = (extra: Record<string, string> = {}) => ({
  params: Promise.resolve({ id: COURSE, conceptId: CONCEPT, ...extra }),
});

function post(url: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(`${ORIGIN}${url}`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", origin: ORIGIN, ...headers },
  });
}

type Call = { url: string; method: string; body: unknown; headers: Headers };

/** Stubs the API service: answers by path, records each call. */
function api(routes: Record<string, () => Response>): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: URL, init: RequestInit) => {
      const body = typeof init.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
      calls.push({
        url: url.pathname,
        method: init.method ?? "GET",
        body,
        headers: new Headers(init.headers),
      });
      const route = routes[`${init.method ?? "GET"} ${url.pathname}`];
      return Promise.resolve(route ? route() : new Response("not here", { status: 404 }));
    }),
  );
  return calls;
}

const EMPTY = { attempts: [], cards: [] };

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("INTERNAL_API_SECRET", "s".repeat(40));
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("POST /api/courses/[id]/attempts", () => {
  const attempt = { conceptId: CONCEPT, correct: true, evidence: "with_hint", source: "quiz" };

  it("schedules the concept with FSRS and stores the attempt with its card", async () => {
    const calls = api({
      [`GET /v1/courses/${COURSE}/learner`]: () => Response.json(EMPTY),
      [`POST /v1/courses/${COURSE}/attempts`]: () => new Response(null, { status: 204 }),
    });
    const { POST } = await import("./courses/[id]/attempts/route");

    const response = await POST(post(`/api/courses/${COURSE}/attempts`, attempt), params());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      conceptId: CONCEPT,
      status: "practised_with_hint",
      attempts: 1,
      independent: 0,
    });
    const stored = calls.find((c) => c.method === "POST");
    expect(stored?.headers.get("X-Mew-Local-User")).toBe("local");
    expect(stored?.headers.get("X-Internal-Secret")).toBe("s".repeat(40));
    expect(stored?.body).toMatchObject({
      concept_id: CONCEPT,
      evidence: "with_hint",
      card: { reps: 1, state: 2 },
    });
  });

  it("validates the attempt and the ids before calling the service", async () => {
    const calls = api({});
    const { POST } = await import("./courses/[id]/attempts/route");
    const url = `/api/courses/${COURSE}/attempts`;

    expect((await POST(post(url, { ...attempt, evidence: "guessed" }), params())).status).toBe(400);
    expect((await POST(post(url, { ...attempt, userId: "someone" }), params())).status).toBe(400);
    expect((await POST(post(url, { ...attempt, conceptId: "x" }), params())).status).toBe(400);
    expect(
      (await POST(post(url, attempt, { origin: "https://evil.example" }), params())).status,
    ).toBe(403);
    expect(
      (await POST(post(url, attempt), { params: Promise.resolve({ id: "../me" }) })).status,
    ).toBe(404);
    expect(calls).toEqual([]);
  });

  it("reports a concept of someone else's course as not found, without details", async () => {
    api({
      [`GET /v1/courses/${COURSE}/learner`]: () => Response.json(EMPTY),
      [`POST /v1/courses/${COURSE}/attempts`]: () =>
        Response.json({ detail: "Concept 3333 belongs to user_bob" }, { status: 404 }),
    });
    const { POST } = await import("./courses/[id]/attempts/route");

    const response = await POST(post(`/api/courses/${COURSE}/attempts`, attempt), params());

    expect(response.status).toBe(404);
    expect(JSON.stringify(await response.json())).not.toContain("user_bob");
  });
});

describe("GET /api/courses/[id]/progress", () => {
  it("derives status and next review from the stored attempts and cards", async () => {
    const due = "2030-01-01T00:00:00.000Z";
    api({
      [`GET /v1/courses/${COURSE}/learner`]: () =>
        Response.json({
          attempts: [
            {
              concept_id: CONCEPT,
              correct: true,
              evidence: "independent",
              source: "practice",
              created_at: "2026-10-18T10:00:00+00:00",
            },
          ],
          cards: [
            {
              concept_id: CONCEPT,
              due_at: due,
              fsrs_state: {
                due,
                stability: 3,
                difficulty: 5,
                elapsed_days: 0,
                scheduled_days: 3,
                learning_steps: 0,
                reps: 1,
                lapses: 0,
                state: 2,
                last_review: "2026-10-18T10:00:00Z",
              },
            },
          ],
        }),
    });
    const { GET } = await import("./courses/[id]/progress/route");

    const response = await GET(new Request(`${ORIGIN}/api/courses/${COURSE}/progress`), params());

    expect(await response.json()).toEqual({
      concepts: [
        {
          conceptId: CONCEPT,
          status: "checked",
          due,
          attempts: 1,
          independent: 1,
          lastAttemptAt: "2026-10-18T10:00:00+00:00",
        },
      ],
    });
  });

  it("refuses cross-site reads and rejects a malformed reply from the service", async () => {
    api({ [`GET /v1/courses/${COURSE}/learner`]: () => Response.json({ attempts: "nope" }) });
    const { GET } = await import("./courses/[id]/progress/route");
    const crossSite = new Request(`${ORIGIN}/api/courses/${COURSE}/progress`, {
      headers: { "sec-fetch-site": "cross-site" },
    });
    expect((await GET(crossSite, params())).status).toBe(403);
    expect((await GET(new Request(`${ORIGIN}/x`), params())).status).toBe(502);
  });
});

describe("POST /api/courses/[id]/concepts/[conceptId]/explored", () => {
  it("starts the concept's card, due now", async () => {
    const calls = api({
      [`POST /v1/courses/${COURSE}/explored`]: () => new Response(null, { status: 204 }),
    });
    const { POST } = await import("./courses/[id]/concepts/[conceptId]/explored/route");

    const response = await POST(
      post(`/api/courses/${COURSE}/concepts/${CONCEPT}/explored`, {}),
      params({ conceptId: CONCEPT }),
    );

    expect(response.status).toBe(204);
    expect(calls[0]?.body).toMatchObject({ concept_id: CONCEPT, card: { reps: 0, state: 0 } });
    const bad = await POST(post("/x", {}), params({ conceptId: "not-a-uuid" }));
    expect(bad.status).toBe(404);
  });
});

describe("GET /api/review", () => {
  it("lists due concepts across courses, marking never-practised ones as new", async () => {
    api({
      "GET /v1/learner/due": () =>
        Response.json({
          cards: [
            {
              course_id: COURSE,
              course_title: "Mechanics",
              concept_id: CONCEPT,
              concept_title: "Friction",
              due_at: "2026-10-18T09:00:00Z",
              reps: 0,
            },
          ],
        }),
    });
    const { GET } = await import("./review/route");

    const response = await GET(new Request(`${ORIGIN}/api/review`));

    expect(await response.json()).toEqual({
      items: [
        {
          courseId: COURSE,
          courseTitle: "Mechanics",
          conceptId: CONCEPT,
          conceptTitle: "Friction",
          due: "2026-10-18T09:00:00Z",
          isNew: true,
        },
      ],
    });
  });
});

describe("POST /api/quiz/grade", () => {
  const body = {
    concept: "Friction",
    question: "Which way does friction act on a sliding box?",
    expected: "Opposite to the motion.",
    recognized: ["against the motion"],
    spoken: "",
    image: null,
  };

  it("grades with the model and returns its verdict", async () => {
    vi.stubEnv("GEMINI_API_KEY", "test-key");
    const gradeAnswer = vi.fn(() =>
      Promise.resolve({ verdict: "correct", feedback: "Yes, it opposes the motion.", note: "" }),
    );
    vi.doMock("@/server/quiz", () => ({ gradeAnswer }));
    const { POST } = await import("./quiz/grade/route");

    const response = await POST(post("/api/quiz/grade", body));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ verdict: "correct" });
    expect(gradeAnswer).toHaveBeenCalledWith(body);
  });

  it("refuses non-PNG images, oversized or cross-origin requests, and is 503 without a model", async () => {
    vi.stubEnv("GEMINI_API_KEY", "test-key");
    const gradeAnswer = vi.fn();
    vi.doMock("@/server/quiz", () => ({ gradeAnswer }));
    const { POST } = await import("./quiz/grade/route");

    expect((await POST(post("/api/quiz/grade", { ...body, image: btoa("GIF89a") }))).status).toBe(
      400,
    );
    expect(
      (await POST(post("/api/quiz/grade", { ...body, question: "x".repeat(2000) }))).status,
    ).toBe(400);
    expect(
      (await POST(post("/api/quiz/grade", body, { origin: "https://evil.example" }))).status,
    ).toBe(403);
    expect(gradeAnswer).not.toHaveBeenCalled();

    vi.stubEnv("GEMINI_API_KEY", "");
    vi.resetModules();
    const { POST: unconfigured } = await import("./quiz/grade/route");
    expect((await unconfigured(post("/api/quiz/grade", body))).status).toBe(503);
  });

  it("hides model failures behind a 502", async () => {
    vi.stubEnv("GEMINI_API_KEY", "test-key");
    vi.doMock("@/server/quiz", () => ({
      gradeAnswer: () => Promise.reject(new Error("quota exceeded for project 1234")),
    }));
    const { POST } = await import("./quiz/grade/route");

    const response = await POST(post("/api/quiz/grade", body));

    expect(response.status).toBe(502);
    expect(JSON.stringify(await response.json())).not.toContain("1234");
  });
});
