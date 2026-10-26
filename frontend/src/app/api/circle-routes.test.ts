import type { CircleStreamEvent } from "@mew/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { jpegBase64 } from "../../../test/jpeg";

/** Circle & Ask (S3.2): the desktop app's routes, with the model calls mocked. */
const ORIGIN = "http://localhost:3000";
const TOKEN = `mewdt_${"A".repeat(43)}`;
const SESSION = "11111111-1111-4111-8111-111111111111";
const CLIP_ID = "55555555-5555-4555-8555-555555555555";
const DEVICE = {
  userId: "local",
  deviceId: "22222222-2222-4222-8222-222222222222",
  scopes: ["screen"],
};
const ASK = {
  sessionId: SESSION,
  question: { source: "none" },
  marks: [
    {
      number: 1,
      kind: "circle",
      box: { left: 100, top: 100, right: 900, bottom: 900 },
      polygon: [],
      text: "velocity",
    },
  ],
  focus: {
    image: { jpeg: jpegBase64(800, 400), width: 800, height: 400 },
    widthPx: 1200,
    heightPx: 600,
  },
  context: { jpeg: jpegBase64(1600, 900), width: 1600, height: 900 },
  blocks: [],
  app: "msedge.exe",
  kind: "video",
  history: [],
};
const STEP: CircleStreamEvent = {
  type: "step",
  step: { index: 0, say: "This axis is velocity.", actions: [] },
  latencyMs: 400,
};
const APPEND = {
  sessionId: SESSION,
  turn: { question: "And this?", steps: ["That's the steep part."], summary: "Steep." },
  strokes: [],
  strokeSteps: [],
  conceptHints: [],
};

const PHYSICS = "33333333-3333-4333-8333-333333333333";
const FORCES = "44444444-4444-4444-8444-444444444444";
const node = (id: string, parentId: string | null, title: string, position: string) => ({
  id,
  parentId,
  title,
  position,
  childLabel: "Chapters",
  icon: null,
  color: null,
  courseId: null,
  deletedAt: null,
  editedAt: 1,
});
const TREE = {
  nodes: [node(PHYSICS, null, "Physics", "a0"), node(FORCES, PHYSICS, "Chapter 2 · Forces", "a0")],
};

type Call = { path: string; headers: Headers; body?: unknown };

function api(verifyStatus = 200, appendStatus = 200, moveStatus = 204): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: URL, init: RequestInit) => {
      calls.push({
        path: url.pathname,
        headers: new Headers(init.headers),
        ...(typeof init.body === "string" && { body: JSON.parse(init.body) as unknown }),
      });
      if (url.pathname === "/v1/notebooks/device-tree") return Promise.resolve(Response.json(TREE));
      if (url.pathname === "/v1/moments/file") {
        return Promise.resolve(
          Response.json({
            method: "content_match",
            nodeId: FORCES,
            path: ["Physics", "Chapter 2 · Forces"],
            score: 0.9,
            matched: "projectile motion",
            alternatives: [],
            newNotebook: null,
          }),
        );
      }
      if (url.pathname === "/v1/clips/destination") {
        return Promise.resolve(new Response(null, { status: moveStatus }));
      }
      if (url.pathname === "/v1/devices/verify") {
        return Promise.resolve(
          verifyStatus === 200
            ? Response.json(DEVICE)
            : new Response(null, { status: verifyStatus }),
        );
      }
      if (url.pathname === "/v1/clips/entries/append") {
        return Promise.resolve(
          appendStatus === 200
            ? Response.json({ clipId: CLIP_ID })
            : new Response(null, { status: appendStatus }),
        );
      }
      return Promise.resolve(new Response(null, { status: 204 }));
    }),
  );
  return calls;
}

function request(url: string, body: unknown, token: string | null = TOKEN) {
  return new Request(`${ORIGIN}${url}`, {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      ...(token && { authorization: `Bearer ${token}` }),
    },
  });
}

/** What the (mocked) model answered: what K8 files by. */
const ANSWERED = {
  readQuestion: "Explain this",
  steps: [],
  summary: "A flat line means constant speed.",
  followUpQuestion: null,
  conceptHints: ["projectile motion"],
  subject: "physics",
  checkQuestion: {
    kind: "short",
    prompt: "Why is a thrown ball's path curved?",
    choices: [],
    answerKey: "Gravity pulls it down while it moves sideways.",
    answerLatex: null,
    problemLatex: null,
  },
};

/** The questions the (mocked) model was asked. */
let askedAbout: unknown[] = [];

beforeEach(() => {
  askedAbout = [];
  vi.resetModules();
  vi.stubEnv("INTERNAL_API_SECRET", "s".repeat(40));
  vi.stubEnv("GEMINI_API_KEY", "test-key");
  vi.doMock("@/server/circle-ask", () => ({
    runCircleAsk: async function* (
      asked: { question: unknown },
      _signal: unknown,
      _deps: unknown,
      onAnswer?: (answer: unknown) => Promise<readonly CircleStreamEvent[]>,
    ) {
      await Promise.resolve();
      askedAbout.push(asked.question);
      yield STEP;
      // Like the real one: the hook's events go before `done`.
      if (onAnswer) yield* await onAnswer(ANSWERED);
    },
    readQuestion: () =>
      Promise.resolve({ questions: ["Find x"], handwritten: true, confidence: 0.6 }),
  }));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.doUnmock("@/server/circle-ask");
});

describe("POST /api/screen/circle-ask", () => {
  it("streams the steps for a valid device", async () => {
    api();
    const { POST } = await import("./screen/circle-ask/route");
    const response = await POST(request("/api/screen/circle-ask", ASK));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/x-ndjson");
    // The step, then (K8) where the moment was filed.
    expect((await response.text()).trim().split("\n")[0]).toBe(JSON.stringify(STEP));
  });

  it("needs a device token, a valid body and real JPEGs", async () => {
    api();
    const { POST } = await import("./screen/circle-ask/route");
    expect((await POST(request("/api/screen/circle-ask", ASK, null))).status).toBe(401);
    for (const body of [
      "not json",
      { ...ASK, marks: [] },
      { ...ASK, question: { source: "typed", text: "" } },
      { ...ASK, context: { ...ASK.context, jpeg: btoa("<svg/>") } },
    ]) {
      const response = await POST(request("/api/screen/circle-ask", body));
      expect(response.status, JSON.stringify(body).slice(0, 50)).toBe(400);
    }
  });

  it("answers 503 without a model, and is rate limited", async () => {
    api();
    vi.stubEnv("GEMINI_API_KEY", "");
    const off = await import("./screen/circle-ask/route");
    expect((await off.POST(request("/api/screen/circle-ask", ASK))).status).toBe(503);

    vi.resetModules();
    vi.stubEnv("GEMINI_API_KEY", "test-key");
    const { POST } = await import("./screen/circle-ask/route");
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      const response = await POST(request("/api/screen/circle-ask", ASK));
      await response.text();
      statuses.push(response.status);
    }
    expect(statuses.slice(0, 10).every((s) => s === 200)).toBe(true);
    expect(statuses[10]).toBe(429);
  });
});

describe("POST /api/screen/read-question", () => {
  it("reads the selected area", async () => {
    api();
    const { POST } = await import("./screen/read-question/route");
    const response = await POST(
      request("/api/screen/read-question", {
        image: { jpeg: jpegBase64(300, 80), width: 300, height: 80 },
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      questions: ["Find x"],
      handwritten: true,
      confidence: 0.6,
    });
  });

  it("refuses a picture that isn't a JPEG", async () => {
    api();
    const { POST } = await import("./screen/read-question/route");
    const response = await POST(
      request("/api/screen/read-question", {
        image: { jpeg: btoa("GIF89a"), width: 3, height: 3 },
      }),
    );
    expect(response.status).toBe(400);
  });
});

describe("POST /api/screen/entries/append", () => {
  it("adds a follow-up with the device's token, and needs no model", async () => {
    const calls = api();
    vi.stubEnv("GEMINI_API_KEY", "");
    const { POST } = await import("./screen/entries/append/route");
    const response = await POST(request("/api/screen/entries/append", APPEND));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ clipId: CLIP_ID });
    const append = calls.find((c) => c.path === "/v1/clips/entries/append");
    expect(append?.headers.get("x-mew-device-token")).toBe(TOKEN);
  });

  it("passes on a missing or full entry, and refuses steps that don't match", async () => {
    api(200, 404);
    const missing = await import("./screen/entries/append/route");
    expect((await missing.POST(request("/api/screen/entries/append", APPEND))).status).toBe(404);

    vi.resetModules();
    api(200, 413);
    const full = await import("./screen/entries/append/route");
    expect((await full.POST(request("/api/screen/entries/append", APPEND))).status).toBe(413);

    const mismatched = { ...APPEND, strokeSteps: [0] };
    expect((await full.POST(request("/api/screen/entries/append", mismatched))).status).toBe(400);
  });
});

describe("save where I say (K3)", () => {
  it("takes the place out of the question and sends it first", async () => {
    const calls = api();
    const { POST } = await import("./screen/circle-ask/route");
    const asked = {
      ...ASK,
      question: { source: "voice", text: "why is this negative? save it to physics chapter 2" },
    };
    const response = await POST(request("/api/screen/circle-ask", asked));
    const [first, second] = (await response.text()).trim().split("\n");
    expect(JSON.parse(first ?? "")).toMatchObject({
      type: "destination",
      phrase: "physics chapter 2",
      resolution: {
        kind: "resolved",
        destination: { nodeId: FORCES, path: ["Physics", "Chapter 2 · Forces"] },
      },
    });
    expect(JSON.parse(second ?? "")).toEqual(STEP);
    // The model never sees where it's saved.
    expect(askedAbout).toEqual([{ source: "voice", text: "why is this negative?" }]);
    const tree = calls.find((c) => c.path === "/v1/notebooks/device-tree");
    expect(tree?.headers.get("x-mew-device-token")).toBe(TOKEN);
  });

  it("resolves typed or said words, and lists the picker's places", async () => {
    api();
    const resolve = await import("./screen/destinations/resolve/route");
    const resolved = await resolve.POST(
      request("/api/screen/destinations/resolve", { phrase: "physics chapter 5" }),
    );
    expect(await resolved.json()).toEqual({
      resolution: {
        kind: "missing",
        parentId: PHYSICS,
        parentPath: ["Physics"],
        title: "Chapter 5",
        page: { kind: "from_screen" },
      },
    });
    expect(
      (await resolve.POST(request("/api/screen/destinations/resolve", { phrase: "" }))).status,
    ).toBe(400);
    expect(
      (await resolve.POST(request("/api/screen/destinations/resolve", { phrase: "x" }, null)))
        .status,
    ).toBe(401);

    const places = await import("./screen/destinations/route");
    const listed = await places.POST(request("/api/screen/destinations", {}));
    expect(await listed.json()).toEqual({
      places: [
        { nodeId: PHYSICS, path: ["Physics"] },
        { nodeId: FORCES, path: ["Physics", "Chapter 2 · Forces"] },
      ],
    });
  });

  it("moves a saved moment (never copies it), for the device's own clips", async () => {
    const calls = api();
    const move = await import("./screen/entries/destination/route");
    const body = {
      clipId: CLIP_ID,
      destination: {
        nodeId: FORCES,
        page: { kind: "from_screen" },
        path: ["Physics", "Chapter 2"],
      },
    };
    expect((await move.POST(request("/api/screen/entries/destination", body))).status).toBe(204);
    const sent = calls.find((c) => c.path === "/v1/clips/destination");
    expect(sent?.body).toEqual({ clipId: CLIP_ID, destination: body.destination });
    expect(sent?.headers.get("x-mew-device-token")).toBe(TOKEN);

    for (const bad of [
      { ...body, clipId: "nope" },
      { ...body, destination: { nodeId: FORCES, page: { kind: "somewhere" } } },
    ]) {
      expect((await move.POST(request("/api/screen/entries/destination", bad))).status).toBe(400);
    }

    vi.resetModules();
    api(200, 200, 404);
    const missing = await import("./screen/entries/destination/route");
    expect((await missing.POST(request("/api/screen/entries/destination", body))).status).toBe(404);
  });
});

describe("just tell me the answer (K7)", () => {
  const SOLUTION = {
    problem: { text: "3x + 7 = 19", latex: "3x + 7 = 19" },
    subject: "math",
    steps: [
      { work: "3x = 12", latex: "3x = 12", why: "Subtract 7 from both sides.", figure: null },
    ],
    finalAnswer: { text: "x = 4", latex: "x = 4" },
    yourTurn: {
      problem: "5x − 4 = 21",
      latex: "5x - 4 = 21",
      answerKey: { text: "x = 5", latex: "x = 5" },
      skill: "two-step equations",
      conceptIds: [],
    },
    verification: { method: "sympy", passed: true },
    yourTurnVerified: true,
  };
  const FORGED = {
    problem: { text: "2 + 2", latex: null },
    steps: [{ work: "trust me", latex: null, why: "Because." }],
    finalAnswer: { text: "5", latex: null },
    yourTurn: null,
  };

  beforeEach(() => {
    vi.doMock("@/server/solution", () => ({
      solve: () => Promise.resolve({ type: "solution", solution: SOLUTION }),
      checkMathRemote: () => Promise.resolve(null),
    }));
  });
  afterEach(() => {
    vi.doUnmock("@/server/solution");
  });

  it("shows the verified steps, then the entry gets the server's solution, never the device's", async () => {
    const calls = api();
    const ask = await import("./screen/circle-ask/route");
    const response = await ask.POST(
      request("/api/screen/circle-ask", {
        ...ASK,
        question: { source: "voice", text: "just tell me the answer" },
      }),
    );
    const events = (await response.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as CircleStreamEvent);
    expect(askedAbout).toEqual([]); // not an ordinary Circle & Ask answer
    expect(
      events.filter((e) => e.type === "step").map((e) => e.type === "step" && e.step.say),
    ).toEqual([
      "Subtract 7 from both sides.",
      "So the answer is x = 4. Your turn is in Physics › Chapter 2 · Forces.",
    ]);

    const append = await import("./screen/entries/append/route");
    await append.POST(request("/api/screen/entries/append", { ...APPEND, solution: FORGED }));
    const sent = calls.find((c) => c.path === "/v1/clips/entries/append")?.body as {
      solution?: { finalAnswer: { text: string } };
    };
    expect(sent.solution?.finalAnswer.text).toBe("x = 4");

    // Taken once: the next follow-up carries none, and a forged one is dropped.
    await append.POST(request("/api/screen/entries/append", { ...APPEND, solution: FORGED }));
    const again = calls.filter((c) => c.path === "/v1/clips/entries/append").at(-1)?.body;
    expect(again).not.toHaveProperty("solution");
  });

  it("an ordinary question still gets an ordinary answer", async () => {
    api();
    const { POST } = await import("./screen/circle-ask/route");
    const response = await POST(
      request("/api/screen/circle-ask", {
        ...ASK,
        question: { source: "typed", text: "how do I solve this?" },
      }),
    );
    expect((await response.text()).trim().split("\n")[0]).toBe(JSON.stringify(STEP));
    expect(askedAbout).toEqual([{ source: "typed", text: "how do I solve this?" }]);
  });
});

describe("filing a moment by what it's about (K8)", () => {
  const events = async (response: Response) =>
    (await response.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as CircleStreamEvent);

  it("tells the card where it went (and why) before the answer ends, when nothing was said", async () => {
    const calls = api();
    const { POST } = await import("./screen/circle-ask/route");
    const sent = await events(await POST(request("/api/screen/circle-ask", ASK)));

    const filing = sent.find((e) => e.type === "destination");
    expect(filing).toMatchObject({
      phrase: null,
      resolution: { kind: "resolved", destination: { nodeId: FORCES, method: "filed" } },
      filing: { method: "content_match", note: "matched “projectile motion”", alternatives: [] },
    });
    expect(sent.indexOf(filing as CircleStreamEvent)).toBeGreaterThan(sent.indexOf(STEP));
    const asked = calls.find((c) => c.path === "/v1/moments/file");
    expect(asked?.body).toMatchObject({ subject: "physics", hints: ["projectile motion"] });
    expect(asked?.headers.get("x-mew-device-token")).toBe(TOKEN);

    // The saved entry gets the answer's subject and check question from this server.
    const append = await import("./screen/entries/append/route");
    await append.POST(request("/api/screen/entries/append", APPEND));
    const stored = calls.find((c) => c.path === "/v1/clips/entries/append")?.body as {
      moment?: { subject: string; checkQuestion: { prompt: string } | null };
    };
    expect(stored.moment?.subject).toBe("physics");
    expect(stored.moment?.checkQuestion?.prompt).toBe("Why is a thrown ball's path curved?");
  });

  it("doesn't file what the student said where to save", async () => {
    const calls = api();
    const { POST } = await import("./screen/circle-ask/route");
    const sent = await events(
      await POST(
        request("/api/screen/circle-ask", {
          ...ASK,
          question: { source: "voice", text: "explain this and save it to physics chapter 2" },
        }),
      ),
    );
    expect(sent.filter((e) => e.type === "destination")).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: "destination", phrase: "physics chapter 2" });
    expect(calls.some((c) => c.path === "/v1/moments/file")).toBe(false);
  });
});
