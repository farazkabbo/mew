import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Notes Check N1 routes, in local mode as in development. */
const ORIGIN = "http://localhost:3000";
const PAGE = "22222222-2222-4222-8222-222222222222";
/** The smallest valid PNG signature plus an IHDR chunk header: enough for `assertPng`. */
const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1,
  0, 0, 0, 1, 8, 2, 0, 0, 0,
]).toString("base64");

function request(method: string, url: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(`${ORIGIN}${url}`, {
    method,
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", origin: ORIGIN, ...headers },
  });
}

const context = (pageId: string) => ({ params: Promise.resolve({ pageId }) });

const SYNC = {
  notebook: { id: "11111111-1111-4111-8111-111111111111", title: "Biology", courseId: null },
  pageIndex: 0,
  upsert: [
    {
      id: "33333333-3333-4333-8333-333333333333",
      lineIndex: 0,
      bbox: [10, 20, 200, 24],
      source: "ink",
      text: "enzymes lower activation energy",
      latex: null,
      confidence: 0.9,
      contentHash: "0a1b2c3d",
    },
  ],
  remove: [],
};

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("INTERNAL_API_SECRET", "s".repeat(40));
  vi.stubEnv("GEMINI_API_KEY", "test-key");
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("PUT /api/notes/pages/[pageId]/lines", () => {
  it("passes a page's changes to the API service as the user", async () => {
    const upstream = vi.fn<(url: URL, init: RequestInit) => Promise<Response>>(() =>
      Promise.resolve(Response.json({ embedded: 1 })),
    );
    vi.stubGlobal("fetch", upstream);
    const { PUT } = await import("./notes/pages/[pageId]/lines/route");

    const response = await PUT(
      request("PUT", `/api/notes/pages/${PAGE}/lines`, SYNC),
      context(PAGE),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ embedded: 1 });
    const [url, init] = upstream.mock.calls[0] ?? [];
    expect(String(url)).toContain(`/v1/notes/pages/${PAGE}/lines`);
    expect(init?.method).toBe("PUT");
    expect(JSON.parse(String(init?.body))).toEqual(SYNC);
    expect(new Headers(init?.headers).get("X-Mew-Local-User")).toBe("local");
  });

  it("refuses cross-origin, malformed and oversized requests, and unknown pages", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const { PUT } = await import("./notes/pages/[pageId]/lines/route");
    const path = `/api/notes/pages/${PAGE}/lines`;

    const crossOrigin = request("PUT", path, SYNC, { origin: "https://evil.example" });
    expect((await PUT(crossOrigin, context(PAGE))).status).toBe(403);
    const clipWithoutClip = { ...SYNC, upsert: [{ ...SYNC.upsert[0], source: "clip" }] };
    expect((await PUT(request("PUT", path, clipWithoutClip), context(PAGE))).status).toBe(400);
    const huge = { ...SYNC, upsert: [{ ...SYNC.upsert[0], text: "x".repeat(250_000) }] };
    expect((await PUT(request("PUT", path, huge), context(PAGE))).status).toBe(413);
    expect((await PUT(request("PUT", path, SYNC), context("../../admin"))).status).toBe(404);
  });

  it("says plainly when the student turned the copy off, without upstream details", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json({ detail: "row-level security" }, { status: 403 })),
    );
    const { PUT } = await import("./notes/pages/[pageId]/lines/route");

    const response = await PUT(
      request("PUT", `/api/notes/pages/${PAGE}/lines`, SYNC),
      context(PAGE),
    );

    expect(response.status).toBe(403);
    expect(JSON.stringify(await response.json())).not.toContain("row-level");
  });

  it("rate-limits syncs", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(Response.json({ embedded: 0 }))),
    );
    const { PUT } = await import("./notes/pages/[pageId]/lines/route");

    const statuses: number[] = [];
    for (let i = 0; i < 41; i++) {
      const response = await PUT(
        request("PUT", `/api/notes/pages/${PAGE}/lines`, SYNC),
        context(PAGE),
      );
      statuses.push(response.status);
    }

    expect(statuses.slice(0, 40).every((s) => s === 200)).toBe(true);
    expect(statuses[40]).toBe(429);
  });
});

describe("POST /api/recognize/batch", () => {
  it("recognises the lines in one call", async () => {
    const batch = vi.fn(() =>
      Promise.resolve([{ text: "a", latex: null, subject: "other", confidence: 0.9 }, null]),
    );
    vi.doMock("@/server/recognition", () => ({ recognizeHandwritingBatch: batch }));
    const { POST } = await import("./recognize/batch/route");

    const response = await POST(request("POST", "/api/recognize/batch", { images: [PNG, PNG] }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      lines: [{ text: "a", latex: null, subject: "other", confidence: 0.9 }, null],
    });
    expect(batch).toHaveBeenCalledTimes(1);
  });

  it("refuses non-PNG images and too many lines", async () => {
    vi.doMock("@/server/recognition", () => ({ recognizeHandwritingBatch: vi.fn() }));
    const { POST } = await import("./recognize/batch/route");

    const gif = btoa("GIF89a....");
    expect(
      (await POST(request("POST", "/api/recognize/batch", { images: [PNG, gif] }))).status,
    ).toBe(400);
    const nine = Array.from({ length: 9 }, () => PNG);
    expect((await POST(request("POST", "/api/recognize/batch", { images: nine }))).status).toBe(
      400,
    );
    expect((await POST(request("POST", "/api/recognize/batch", { images: [] }))).status).toBe(400);
  });

  it("allows six batches a minute", async () => {
    vi.doMock("@/server/recognition", () => ({
      recognizeHandwritingBatch: () => Promise.resolve([null]),
    }));
    const { POST } = await import("./recognize/batch/route");

    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) {
      statuses.push(
        (await POST(request("POST", "/api/recognize/batch", { images: [PNG] }))).status,
      );
    }

    expect(statuses).toEqual([200, 200, 200, 200, 200, 200, 429]);
  });

  it("tells the client when to come back after the model was busy", async () => {
    const { ModelBusyError } = await import("@/server/gemini");
    vi.doMock("@/server/recognition", () => ({
      recognizeHandwritingBatch: () => Promise.reject(new ModelBusyError("flash-lite", 30_000)),
    }));
    const { POST } = await import("./recognize/batch/route");

    const response = await POST(request("POST", "/api/recognize/batch", { images: [PNG] }));

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("30");
  });
});

describe("notes checks", () => {
  const SCREEN = [{ blockId: "b1", text: "Enzymes are not consumed by the reaction." }];
  const RESULT = {
    checkId: null,
    related: false,
    topic: "",
    speech: "I couldn't find notes on this yet. Want to start a page for it?",
    scopeLabel: "",
    pages: [],
    findings: [],
    latencyMs: 40,
  };

  it("checks the notebook's own clip against the notes, as the student", async () => {
    const runNotesCheck = vi.fn(() => Promise.resolve(RESULT));
    vi.doMock("@/server/notes-check/run", () => ({ runNotesCheck }));
    const { POST } = await import("./notes/check/route");

    const body = { screen: SCREEN, scope: { kind: "default" }, clipId: PAGE };
    const response = await POST(request("POST", "/api/notes/check", body));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(RESULT);
    expect(runNotesCheck).toHaveBeenCalledWith(
      expect.objectContaining({ screen: SCREEN, clipId: PAGE, app: null }),
      { kind: "student" },
      undefined,
      expect.anything(),
    );
  });

  it("refuses cross-origin, malformed and oversized checks", async () => {
    vi.doMock("@/server/notes-check/run", () => ({ runNotesCheck: vi.fn() }));
    const { POST } = await import("./notes/check/route");
    const ok = { screen: SCREEN, scope: { kind: "default" } };

    expect(
      (await POST(request("POST", "/api/notes/check", ok, { origin: "https://evil.example" })))
        .status,
    ).toBe(403);
    const named = { ...ok, scope: { kind: "notebook" } };
    expect((await POST(request("POST", "/api/notes/check", named))).status).toBe(400);
    const sameBlock = { ...ok, screen: [...SCREEN, ...SCREEN] };
    expect((await POST(request("POST", "/api/notes/check", sameBlock))).status).toBe(400);
    const huge = { ...ok, screen: [{ blockId: "b1", text: "x".repeat(50_000) }] };
    expect((await POST(request("POST", "/api/notes/check", huge))).status).toBe(413);
  });

  it("allows six checks a minute", async () => {
    vi.doMock("@/server/notes-check/run", () => ({
      runNotesCheck: () => Promise.resolve(RESULT),
    }));
    const { POST } = await import("./notes/check/route");
    const body = { screen: SCREEN, scope: { kind: "all" } };

    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) {
      statuses.push((await POST(request("POST", "/api/notes/check", body))).status);
    }

    expect(statuses).toEqual([200, 200, 200, 200, 200, 200, 429]);
  });

  it("says when the model is busy, without details", async () => {
    const { ModelBusyError } = await import("@/server/gemini");
    vi.doMock("@/server/notes-check/run", () => ({
      runNotesCheck: () => Promise.reject(new ModelBusyError("flash", 20_000)),
    }));
    const { POST } = await import("./notes/check/route");

    const response = await POST(
      request("POST", "/api/notes/check", { screen: SCREEN, scope: { kind: "all" } }),
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("20");
  });

  it("needs a device token from the desktop app", async () => {
    vi.doMock("@/server/notes-check/run", () => ({ runNotesCheck: vi.fn() }));
    const { POST } = await import("./screen/notes-check/route");
    const body = { screen: SCREEN, app: "msedge.exe", scope: "default" };

    expect((await POST(request("POST", "/api/screen/notes-check", body))).status).toBe(401);
    const bad = request("POST", "/api/screen/notes-check", body, {
      authorization: "Bearer not-a-device-token",
    });
    expect((await POST(bad)).status).toBe(401);
  });
});

describe("resolving findings", () => {
  const FINDING = "44444444-4444-4444-8444-444444444444";
  const finding = (id: string) => ({ params: Promise.resolve({ id }) });
  const url = (action: string, id = FINDING) => `/api/notes/findings/${id}/${action}`;

  it("checks the student's reply to a finding, as the student", async () => {
    const result = { outcome: "fixed", reply: "That matches now.", status: "resolved_fixed" };
    const resolveFinding = vi.fn(() => Promise.resolve(result));
    vi.doMock("@/server/notes-check/resolve", () => ({ resolveFinding }));
    const { POST } = await import("./notes/findings/[id]/resolve/route");

    const response = await POST(
      request("POST", url("resolve"), { reply: "not used up" }),
      finding(FINDING),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(result);
    expect(resolveFinding).toHaveBeenCalledWith(FINDING, { reply: "not used up" });
  });

  it("refuses cross-origin requests, unknown ids and empty replies", async () => {
    const resolveFinding = vi.fn();
    vi.doMock("@/server/notes-check/resolve", () => ({ resolveFinding }));
    const { POST } = await import("./notes/findings/[id]/resolve/route");
    const body = { reply: "x" };

    const evil = request("POST", url("resolve"), body, { origin: "https://evil.example" });
    expect((await POST(evil, finding(FINDING))).status).toBe(403);
    expect((await POST(request("POST", url("resolve", "1"), body), finding("1"))).status).toBe(404);
    expect((await POST(request("POST", url("resolve"), {}), finding(FINDING))).status).toBe(400);
    expect(resolveFinding).not.toHaveBeenCalled();
  });

  it("says when a finding is already settled", async () => {
    const { HttpError } = await import("@/server/http-error");
    vi.doMock("@/server/notes-check/resolve", () => ({
      dismissFinding: () => Promise.reject(new HttpError(409, "That's already settled")),
    }));
    const { POST } = await import("./notes/findings/[id]/dismiss/route");

    const response = await POST(request("POST", url("dismiss"), {}), finding(FINDING));

    expect(response.status).toBe(409);
  });

  it("allows twenty follow-ups a minute", async () => {
    vi.doMock("@/server/notes-check/resolve", () => ({
      explainFinding: () =>
        Promise.resolve({ explanation: "The slide says…", status: "explained" }),
    }));
    const { POST } = await import("./notes/findings/[id]/explain/route");

    const statuses: number[] = [];
    for (let i = 0; i < 21; i++) {
      statuses.push((await POST(request("POST", url("explain"), {}), finding(FINDING))).status);
    }

    expect(statuses.slice(0, 20).every((s) => s === 200)).toBe(true);
    expect(statuses[20]).toBe(429);
  });

  it("needs the model only for work that uses one", async () => {
    vi.stubEnv("GEMINI_API_KEY", "");
    vi.doMock("@/server/notes-check/resolve", () => ({
      gapHeading: vi.fn(),
      dismissFinding: () => Promise.resolve(),
    }));
    const gap = await import("./notes/findings/[id]/gap-heading/route");
    const dismiss = await import("./notes/findings/[id]/dismiss/route");

    expect((await gap.POST(request("POST", url("gap-heading"), {}), finding(FINDING))).status).toBe(
      503,
    );
    expect((await dismiss.POST(request("POST", url("dismiss"), {}), finding(FINDING))).status).toBe(
      204,
    );
  });

  it("lists a page's open findings, and only for a page id", async () => {
    const userApi = vi.fn(() => Promise.resolve([]));
    vi.doMock("@/server/user-api", () => ({ userApi }));
    const { GET } = await import("./notes/findings/route");

    const ok = await GET(new Request(`${ORIGIN}/api/notes/findings?pageId=${PAGE}`));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual([]);
    expect(userApi).toHaveBeenCalledWith(`/v1/notes/findings?page_id=${PAGE}`, expect.anything());
    expect((await GET(new Request(`${ORIGIN}/api/notes/findings?pageId=x`))).status).toBe(400);
  });
});
