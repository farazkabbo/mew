import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Route handlers run in local mode here (no Clerk keys), as in development. */
const ORIGIN = "http://localhost:3000";

const mewBody = {
  trigger: "utterance",
  lastUtterance: "okay so I'm reading this",
  recentTranscript: [],
  notebookSignals: { msSinceLastStroke: null, justErased: false, linesWrittenLast60s: 0 },
  tutorSpokeRecently: false,
  explicitSummon: false,
};

function post(url: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(`${ORIGIN}${url}`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", origin: ORIGIN, ...headers },
  });
}

beforeEach(() => {
  vi.resetModules();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("POST /api/mew", () => {
  it("classifies a valid request", async () => {
    vi.doMock("@/server/mew-gate", () => ({
      classifyMew: () =>
        Promise.resolve({
          output: { label: "ignore", confidence: 0.9, reason: "reading aloud" },
          source: "model",
          latencyMs: 120,
        }),
    }));
    const { POST } = await import("./mew/route");

    const response = await POST(post("/api/mew", mewBody));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ output: { label: "ignore" }, source: "model" });
  });

  it("rejects cross-origin and malformed requests", async () => {
    const { POST } = await import("./mew/route");

    expect((await POST(post("/api/mew", mewBody, { origin: "https://evil.example" }))).status).toBe(
      403,
    );
    expect((await POST(post("/api/mew", { ...mewBody, explicitSummon: "yes" }))).status).toBe(400);
    expect(
      (await POST(post("/api/mew", { ...mewBody, lastUtterance: "x".repeat(10_000) }))).status,
    ).toBe(413);
  });

  it("rate-limits a user", async () => {
    vi.doMock("@/server/mew-gate", () => ({
      classifyMew: () =>
        Promise.resolve({
          output: { label: "ignore", confidence: 1, reason: "" },
          source: "rule",
          latencyMs: 0,
        }),
    }));
    const { POST } = await import("./mew/route");

    const statuses: number[] = [];
    for (let i = 0; i < 41; i++) statuses.push((await POST(post("/api/mew", mewBody))).status);

    expect(statuses.slice(0, 40).every((s) => s === 200)).toBe(true);
    expect(statuses[40]).toBe(429);
  });
});

describe("POST /api/stt/token", () => {
  it("mints a single-use token with the server-side key, which never reaches the client", async () => {
    vi.stubEnv("ELEVENLABS_API_KEY", "xi-secret-key");
    const upstream = vi.fn().mockResolvedValue(Response.json({ token: "sutkn_123" }));
    vi.stubGlobal("fetch", upstream);
    const { POST } = await import("./stt/token/route");

    const response = await POST(post("/api/stt/token", {}));
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(JSON.parse(text)).toEqual({
      token: "sutkn_123",
      modelId: "scribe_v2_realtime",
      url: "wss://api.elevenlabs.io/v1/speech-to-text/realtime",
    });
    expect(text).not.toContain("xi-secret-key");
    const [url, init] = upstream.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.elevenlabs.io/v1/single-use-token/realtime_scribe");
    expect(new Headers(init.headers).get("xi-api-key")).toBe("xi-secret-key");
  });

  it("reports 503 when speech-to-text is not configured", async () => {
    vi.stubEnv("ELEVENLABS_API_KEY", "");
    const { POST } = await import("./stt/token/route");

    const response = await POST(post("/api/stt/token", {}));

    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("ELEVENLABS");
  });

  it("maps upstream failures to 502", async () => {
    vi.stubEnv("ELEVENLABS_API_KEY", "xi-secret-key");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("nope", { status: 401 })));
    const { POST } = await import("./stt/token/route");

    expect((await POST(post("/api/stt/token", {}))).status).toBe(502);
  });
});
