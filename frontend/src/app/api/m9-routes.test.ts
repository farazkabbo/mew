import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Settings, voices, speech errors and telemetry (M9), in local mode as in development. */
const ORIGIN = "http://localhost:3000";
const VOICE = "JBFqnCBsd6RMkjVDRZzb";
const OTHER_VOICE = "b8gbDO0ybjX1VA89pBdX";

function request(
  method: string,
  url: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  return new Request(`${ORIGIN}${url}`, {
    method,
    ...(body !== undefined && { body: JSON.stringify(body) }),
    headers: { "content-type": "application/json", origin: ORIGIN, ...headers },
  });
}

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("INTERNAL_API_SECRET", "s".repeat(40));
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("/api/settings", () => {
  const SETTINGS = {
    mew_threshold: 0.8,
    answer_style: "direct",
    captions: true,
    auto_check: false,
    listen_on_open: false,
    voice_id: null,
    language: "en",
    mew_logging_opt_in: false,
    notes_index: true,
    onboarded: true,
    shortcuts: { jump: "Alt+J" },
    shortcuts_notice_seen: true,
    your_turn_after_solution: true,
    quiz_saved_moments: true,
    notify_moment_checks: false,
    learn_handwriting: true,
  };

  it("passes a valid change to the API service as the user", async () => {
    const fetchMock = vi.fn<(url: URL, init: RequestInit) => Promise<Response>>(() =>
      Promise.resolve(Response.json(SETTINGS)),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { PATCH } = await import("./settings/route");

    const response = await PATCH(request("PATCH", "/api/settings", { mew_threshold: 0.8 }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(SETTINGS);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toContain("/v1/me/settings");
    expect(init?.method).toBe("PATCH");
    expect(new Headers(init?.headers).get("X-Mew-Local-User")).toBe("local");
  });

  it("refuses unknown keys, bad values and other origins before calling the service", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { PATCH } = await import("./settings/route");

    for (const body of [{ is_admin: true }, { mew_threshold: 5 }, { voice_id: "../x" }]) {
      expect((await PATCH(request("PATCH", "/api/settings", body))).status).toBe(400);
    }
    const crossOrigin = request(
      "PATCH",
      "/api/settings",
      { captions: false },
      {
        origin: "https://evil.example",
      },
    );
    expect((await PATCH(crossOrigin)).status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("/api/voices and /api/tts", () => {
  beforeEach(() => {
    vi.stubEnv("ELEVENLABS_API_KEY", "el-key");
    vi.stubEnv("ELEVENLABS_VOICE_ID", VOICE);
  });

  it("offers the default voice and any listed ones", async () => {
    vi.stubEnv("ELEVENLABS_VOICES", `George:${VOICE},Calm:${OTHER_VOICE}`);
    const { GET } = await import("./voices/route");
    const body = (await (await GET(new Request(`${ORIGIN}/api/voices`))).json()) as unknown;
    expect(body).toEqual({
      voices: [
        { id: VOICE, name: "George" },
        { id: OTHER_VOICE, name: "Calm" },
      ],
    });
  });

  it("only ever sends an allowed voice upstream", async () => {
    const fetchMock = vi.fn<(url: URL, init: RequestInit) => Promise<Response>>(() =>
      Promise.resolve(new Response(new Uint8Array(4))),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { POST } = await import("./tts/route");

    await POST(request("POST", "/api/tts", { text: "Hi.", voiceId: "AAAAAAAAAAAA" }));
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(`/text-to-speech/${VOICE}/`);
    expect((await POST(request("POST", "/api/tts", { text: "Hi.", voiceId: "../x" }))).status).toBe(
      400,
    );
  });

  it("explains a voice that needs a paid ElevenLabs plan", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response("paid_plan_required", { status: 402 }))),
    );
    const { POST } = await import("./tts/route");

    const response = await POST(request("POST", "/api/tts", { text: "Hi." }));

    expect(response.status).toBe(503);
    const { error } = (await response.json()) as { error: string };
    expect(error).toMatch(/paid ElevenLabs plan/);
    expect(error).not.toContain("paid_plan_required");
  });
});

describe("/api/telemetry", () => {
  const turn = { intent: "answer_question", outcome: "done", gateMs: 300, firstAudioMs: 1200 };

  it("records timings and reports the caller's percentiles", async () => {
    const { GET, POST } = await import("./telemetry/route");

    expect((await POST(request("POST", "/api/telemetry", { turns: [turn, turn] }))).status).toBe(
      204,
    );
    const report = (await (await GET(new Request(`${ORIGIN}/api/telemetry`))).json()) as {
      turns: number;
      stages: Record<string, { p50: number } | null>;
    };
    expect(report.turns).toBe(2);
    expect(report.stages.gateMs?.p50).toBe(300);
    expect(report.stages.inkStartMs).toBeNull();
  });

  it("accepts timings only, never content", async () => {
    const { POST } = await import("./telemetry/route");
    const withText = { turns: [{ ...turn, utterance: "my secret question" }] };
    expect((await POST(request("POST", "/api/telemetry", withText))).status).toBe(400);
    expect((await POST(request("POST", "/api/telemetry", { turns: [] }))).status).toBe(400);
  });
});
