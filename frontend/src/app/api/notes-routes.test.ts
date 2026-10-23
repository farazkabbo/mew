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
