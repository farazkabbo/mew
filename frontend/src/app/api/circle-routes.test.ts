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

/** The questions the (mocked) model was asked. */
let askedAbout: unknown[] = [];

beforeEach(() => {
  askedAbout = [];
  vi.resetModules();
  vi.stubEnv("INTERNAL_API_SECRET", "s".repeat(40));
  vi.stubEnv("GEMINI_API_KEY", "test-key");
  vi.doMock("@/server/circle-ask", () => ({
    runCircleAsk: async function* (asked: { question: unknown }) {
      await Promise.resolve();
      askedAbout.push(asked.question);
      yield STEP;
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
    expect((await response.text()).trim()).toBe(JSON.stringify(STEP));
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
