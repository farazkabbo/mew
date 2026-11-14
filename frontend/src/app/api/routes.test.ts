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

const tutorBody = {
  intent: "answer_question",
  lastUtterance: "why does the force cancel out?",
  recentTranscript: [],
  pageImage: null,
  recognizedLines: [],
  answerStyle: "hints_first",
  depth: "normal",
  previousTutorSpeech: [],
};

describe("POST /api/tutor", () => {
  it("streams NDJSON events from the tutor", async () => {
    vi.stubEnv("GEMINI_API_KEY", "test-key");
    vi.doMock("@/server/tutor", () => ({
      runTutor: async function* () {
        await Promise.resolve();
        yield { type: "speech", text: "Think about directions.", latencyMs: 300 };
        yield {
          type: "response",
          response: { speech: "Think about directions.", actions: [] },
          latencyMs: 900,
        };
      },
    }));
    const { POST } = await import("./tutor/route");

    const response = await POST(post("/api/tutor", tutorBody));
    const lines = (await response.text())
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { type: string });

    expect(response.headers.get("content-type")).toContain("application/x-ndjson");
    expect(lines.map((l) => l.type)).toEqual(["speech", "response"]);
  });

  it("refuses a non-PNG page image before calling the model", async () => {
    vi.stubEnv("GEMINI_API_KEY", "test-key");
    const runTutor = vi.fn();
    vi.doMock("@/server/tutor", () => ({ runTutor }));
    const { POST } = await import("./tutor/route");

    const response = await POST(post("/api/tutor", { ...tutorBody, pageImage: btoa("<svg/>") }));

    expect(response.status).toBe(400);
    expect(runTutor).not.toHaveBeenCalled();
  });

  it("is 503 when the model isn't configured", async () => {
    vi.stubEnv("GEMINI_API_KEY", "");
    const { POST } = await import("./tutor/route");

    expect((await POST(post("/api/tutor", tutorBody))).status).toBe(503);
  });
});

describe("POST /api/tts", () => {
  beforeEach(() => {
    vi.stubEnv("ELEVENLABS_API_KEY", "xi-secret-key");
    vi.stubEnv("ELEVENLABS_VOICE_ID", "Voice1234abcd");
  });

  it("proxies streaming PCM without exposing the key", async () => {
    const upstream = vi.fn().mockResolvedValue(new Response(new Uint8Array([1, 0, 255, 255])));
    vi.stubGlobal("fetch", upstream);
    const { POST } = await import("./tts/route");

    const response = await POST(post("/api/tts", { text: "Hello there." }));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("audio/pcm;rate=24000");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 0, 255, 255]));
    const [url, init] = upstream.mock.calls[0] as [URL, RequestInit];
    expect(String(url)).toBe(
      "https://api.elevenlabs.io/v1/text-to-speech/Voice1234abcd/stream?output_format=pcm_24000",
    );
    expect(JSON.parse(String(init.body))).toEqual({
      text: "Hello there.",
      model_id: "eleven_flash_v2_5",
    });
  });

  it("speaks Bengali with the model that can, and uses a language's own voice", async () => {
    vi.stubEnv("ELEVENLABS_API_KEY", "xi-secret-key");
    vi.stubEnv("ELEVENLABS_VOICE_ID", "Voice1234abcd");
    vi.stubEnv("ELEVENLABS_VOICE_FR", "French1234abcd");
    const upstream = vi.fn(async () => new Response(new Uint8Array([1, 0])));
    vi.stubGlobal("fetch", upstream);
    const { POST } = await import("./tts/route");

    await POST(post("/api/tts", { text: "নমস্কার", language: "bn" }));
    const [bnUrl, bn] = upstream.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(bnUrl)).toContain("/Voice1234abcd/");
    expect(JSON.parse(String(bn.body))).toEqual({
      text: "নমস্কার",
      model_id: "eleven_v4_turbo",
      language_code: "bn",
    });

    await POST(post("/api/tts", { text: "Bonjour", language: "fr" }));
    const [frUrl, fr] = upstream.mock.calls[1] as unknown as [URL, RequestInit];
    expect(String(frUrl)).toContain("/French1234abcd/");
    expect(JSON.parse(String(fr.body))).toMatchObject({
      model_id: "eleven_flash_v2_5",
      language_code: "fr",
    });

    const refused = await POST(post("/api/tts", { text: "Hi", language: "xx" }));
    expect(refused.status).toBe(400);
  });

  it("budgets by characters per minute", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response(new Uint8Array(2)))),
    );
    const { POST } = await import("./tts/route");
    const text = "x".repeat(600);

    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await POST(post("/api/tts", { text }))).status);

    expect(statuses).toEqual([200, 200, 200, 200, 200, 429]); // 3000 chars/minute
  });

  it("refuses an unsafe voice id configuration", async () => {
    vi.stubEnv("ELEVENLABS_VOICE_ID", "../../v1/user");
    const { POST } = await import("./tts/route");

    expect((await POST(post("/api/tts", { text: "hi" }))).status).toBe(503);
  });
});

describe("POST /api/recognize", () => {
  it("rejects images that aren't PNGs", async () => {
    vi.stubEnv("GEMINI_API_KEY", "test-key");
    const { POST } = await import("./recognize/route");

    expect((await POST(post("/api/recognize", { image: btoa("GIF89a....") }))).status).toBe(400);
  });
});

describe("POST /api/check/math", () => {
  const results = [
    { index: 0, verdict: "unknown", reason: "first_line", detail: null },
    {
      index: 1,
      verdict: "incorrect",
      reason: "changes_solutions",
      detail: "x = 2 before, x = 5 after",
    },
  ];

  it("forwards the steps to the API service with the internal secret", async () => {
    vi.stubEnv("API_BASE_URL", "http://api.internal:8000");
    vi.stubEnv("INTERNAL_API_SECRET", "s".repeat(40));
    const fetchMock = vi.fn<(url: URL, init: RequestInit) => Promise<Response>>(() =>
      Promise.resolve(Response.json({ results })),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { POST } = await import("./check/math/route");

    const response = await POST(post("/api/check/math", { steps: ["2x+3=7", "2x=10"] }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ results });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe("http://api.internal:8000/v1/check/math");
    expect(new Headers(init?.headers).get("X-Internal-Secret")).toBe("s".repeat(40));
    expect(JSON.parse(String(init?.body))).toEqual({ steps: ["2x+3=7", "2x=10"] });
  });

  it("rejects cross-origin, oversized and malformed requests before calling the service", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { POST } = await import("./check/math/route");

    const steps = ["x=1"];
    expect(
      (await POST(post("/api/check/math", { steps }, { origin: "https://evil.example" }))).status,
    ).toBe(403);
    expect((await POST(post("/api/check/math", { steps: [] }))).status).toBe(400);
    expect((await POST(post("/api/check/math", { steps: Array(9).fill("x=1") }))).status).toBe(400);
    expect((await POST(post("/api/check/math", { steps: ["x".repeat(9000)] }))).status).toBe(413);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports an unreachable checker as 503 and a bad reply as 502, without details", async () => {
    vi.stubEnv("INTERNAL_API_SECRET", "s".repeat(40));
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new TypeError("connect ECONNREFUSED"))),
    );
    let { POST } = await import("./check/math/route");
    let response = await POST(post("/api/check/math", { steps: ["x=1"] }));
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain("ECONNREFUSED");

    vi.resetModules();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(Response.json({ nope: true }))),
    );
    ({ POST } = await import("./check/math/route"));
    response = await POST(post("/api/check/math", { steps: ["x=1"] }));
    expect(response.status).toBe(502);
  });
});

describe("POST /api/courses", () => {
  const COURSE = {
    id: "22222222-2222-4222-8222-222222222222",
    title: "Forces",
    status: "processing",
    created_at: "2026-10-17T12:00:00Z",
  };

  function upload(file: Blob | null, title = "Forces", headers: Record<string, string> = {}) {
    const form = new FormData();
    if (file) form.set("file", file, "chapter.pdf");
    form.set("title", title);
    return new Request(`${ORIGIN}/api/courses`, {
      method: "POST",
      body: form,
      headers: { origin: ORIGIN, ...headers },
    });
  }

  it("forwards a real PDF to the API as the local user (local mode)", async () => {
    vi.stubEnv("INTERNAL_API_SECRET", "s".repeat(40));
    const fetchMock = vi.fn<(url: URL, init: RequestInit) => Promise<Response>>(() =>
      Promise.resolve(Response.json(COURSE, { status: 202 })),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { POST } = await import("./courses/route");

    const response = await POST(upload(new Blob(["%PDF-1.4 tiny"], { type: "application/pdf" })));

    expect(response.status).toBe(202);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toContain("/v1/courses?title=Forces");
    const headers = new Headers(init?.headers);
    expect(headers.get("X-Mew-Local-User")).toBe("local");
    expect(headers.get("Content-Type")).toBe("application/pdf");
    expect(headers.get("Authorization")).toBeNull();
  });

  it("checks the bytes, the size and the origin before anything reaches the API", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { POST } = await import("./courses/route");

    const notPdf = new Blob(["MZ executable"], { type: "application/pdf" });
    expect((await POST(upload(notPdf))).status).toBe(422);
    expect((await POST(upload(null))).status).toBe(400);
    expect((await POST(upload(notPdf, "x".repeat(200)))).status).toBe(400);
    const pdf = new Blob(["%PDF-1.4"], { type: "application/pdf" });
    expect((await POST(upload(pdf, "Forces", { origin: "https://evil.example" }))).status).toBe(
      403,
    );
    const big = new Blob(["%PDF-", new Uint8Array(16 * 1024 * 1024)]);
    expect((await POST(upload(big))).status).toBe(413);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps API failures to safe errors", async () => {
    vi.stubEnv("INTERNAL_API_SECRET", "s".repeat(40));
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response("boom", { status: 503 }))),
    );
    const { GET } = await import("./courses/route");
    const response = await GET(new Request(`${ORIGIN}/api/courses`));
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain("boom");
  });

  it("refuses cross-site reads", async () => {
    const { GET } = await import("./courses/route");
    const response = await GET(
      new Request(`${ORIGIN}/api/courses`, { headers: { "sec-fetch-site": "cross-site" } }),
    );
    expect(response.status).toBe(403);
  });
});
