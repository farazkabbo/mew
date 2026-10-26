import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** K8's notebook-side moment routes ("File these", a moment moved), in local mode. */
const ORIGIN = "http://localhost:3000";
const CLIP = "66666666-6666-4666-8666-000000000001";
const NODE = "00000000-0000-4000-8000-000000000013";

function request(method: string, url: string, body?: unknown, origin = ORIGIN) {
  return new Request(`${ORIGIN}${url}`, {
    method,
    ...(body !== undefined && { body: JSON.stringify(body) }),
    headers: { "content-type": "application/json", origin },
  });
}

const params = <T>(value: T) => ({ params: Promise.resolve(value) });

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("INTERNAL_API_SECRET", "s".repeat(40));
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("/api/moments/suggestions", () => {
  it("asks the API service as the student and passes its places on", async () => {
    const reply = {
      suggestions: [
        { clipId: CLIP, nodeId: NODE, path: ["Physics", "Chapter 3"], method: "content_match" },
      ],
    };
    const fetchMock = vi.fn<(url: URL, init: RequestInit) => Promise<Response>>(() =>
      Promise.resolve(Response.json(reply)),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { POST } = await import("./moments/suggestions/route");

    const response = await POST(request("POST", "/api/moments/suggestions", { clipIds: [CLIP] }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(reply);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toContain("/v1/clips/suggestions");
    expect(new Headers(init?.headers).get("X-Mew-Local-User")).toBe("local");
  });

  it("refuses bad ids, too many, and other origins before calling the service", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { POST } = await import("./moments/suggestions/route");

    for (const body of [{ clipIds: ["x"] }, { clipIds: Array(31).fill(CLIP) }, { clipIds: [] }]) {
      expect((await POST(request("POST", "/api/moments/suggestions", body))).status).toBe(400);
    }
    const cross = request("POST", "/api/moments/suggestions", { clipIds: [CLIP] }, "https://x.io");
    expect((await POST(cross)).status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("/api/moments/[clipId]/move", () => {
  it("moves the server's copy of a moment the notebook moved", async () => {
    const fetchMock = vi.fn<(url: URL, init: RequestInit) => Promise<Response>>(() =>
      Promise.resolve(new Response(null, { status: 204 })),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { POST } = await import("./moments/[clipId]/move/route");

    const response = await POST(
      request("POST", `/api/moments/${CLIP}/move`, { nodeId: NODE }),
      params({ clipId: CLIP }),
    );

    expect(response.status).toBe(204);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toContain(`/v1/clips/${CLIP}/move`);
    expect(JSON.parse(String(init?.body))).toEqual({ nodeId: NODE });
  });

  it("refuses a bad clip id or node id without calling the service", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { POST } = await import("./moments/[clipId]/move/route");

    const badClip = await POST(
      request("POST", "/api/moments/x/move", { nodeId: NODE }),
      params({ clipId: "../x" }),
    );
    expect(badClip.status).toBe(404);
    const badNode = await POST(
      request("POST", `/api/moments/${CLIP}/move`, { nodeId: "Physics" }),
      params({ clipId: CLIP }),
    );
    expect(badNode.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
