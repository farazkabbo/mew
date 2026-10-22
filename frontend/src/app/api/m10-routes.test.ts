import { DEFAULT_SETTINGS } from "@mew/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Mew v2 (M10) routes, in local mode as in development. */
const ORIGIN = "http://localhost:3000";
const EVENT_ID = "44444444-4444-4444-8444-444444444444";

const INPUT = {
  trigger: "utterance",
  lastUtterance: "why does the force cancel out?",
  recentTranscript: [],
  notebookSignals: { msSinceLastStroke: null, justErased: false, linesWrittenLast60s: 0 },
  tutorSpokeRecently: false,
  explicitSummon: false,
};
const DECISION = {
  output: { label: "answer_question", confidence: 0.9, reason: "question" },
  source: "model",
  latencyMs: 600,
};

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

type Call = { path: string; method: string; body: unknown };

/** The API service: settings with the given opt-in; event writes recorded. */
function api(optIn: boolean): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: URL, init: RequestInit) => {
      const body = typeof init.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
      calls.push({ path: url.pathname, method: init.method ?? "GET", body });
      if (url.pathname === "/v1/me/settings") {
        return Promise.resolve(
          Response.json({ ...DEFAULT_SETTINGS, mew_logging_opt_in: optIn, ...(body as object) }),
        );
      }
      if (url.pathname === "/v1/mew/events" && init.method === "POST") {
        return Promise.resolve(Response.json({ logged: true }));
      }
      return Promise.resolve(new Response(null, { status: 204 }));
    }),
  );
  return calls;
}

const logged = (calls: Call[]) =>
  calls.filter((c) => c.path === "/v1/mew/events" && c.method === "POST");

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("INTERNAL_API_SECRET", "s".repeat(40));
  vi.doMock("@/server/mew-gate", () => ({ classifyMew: () => Promise.resolve(DECISION) }));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.doUnmock("@/server/mew-gate");
});

describe("gate decisions are kept only with opt-in", () => {
  it("logs the decision after answering when the student opted in", async () => {
    const calls = api(true);
    const { POST } = await import("./mew/route");

    const response = await POST(request("POST", "/api/mew", INPUT));

    expect(response.status).toBe(200);
    await vi.waitFor(() => expect(logged(calls)).toHaveLength(1));
    expect(logged(calls)[0]?.body).toEqual({
      input: INPUT,
      output: DECISION.output,
      source: "model",
      latencyMs: 600,
    });
  });

  it("sends nothing without opt-in, and opting out applies to the very next decision", async () => {
    const calls = api(false);
    const { POST } = await import("./mew/route");
    await POST(request("POST", "/api/mew", INPUT));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(logged(calls)).toHaveLength(0);

    // Opt in, then out again, through the settings route: the cached answer follows.
    const settings = await import("./settings/route");
    await settings.PATCH(request("PATCH", "/api/settings", { mew_logging_opt_in: true }));
    await POST(request("POST", "/api/mew", INPUT));
    await vi.waitFor(() => expect(logged(calls)).toHaveLength(1));
    vi.unstubAllGlobals();
    const after = api(false);
    await settings.PATCH(request("PATCH", "/api/settings", { mew_logging_opt_in: false }));
    await POST(request("POST", "/api/mew", INPUT));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(logged(after)).toHaveLength(0);
  });
});

describe("/api/mew/events", () => {
  it("accepts only on-device decisions from the browser", async () => {
    const calls = api(true);
    const { POST } = await import("./mew/events/route");
    const event = { input: INPUT, ...DECISION };

    expect((await POST(request("POST", "/api/mew/events", event))).status).toBe(400);
    const local = await POST(request("POST", "/api/mew/events", { ...event, source: "local" }));
    expect(await local.json()).toEqual({ logged: true });
    expect(logged(calls)[0]?.body).toMatchObject({ source: "local" });
  });

  it("validates labels, ids and origins before calling the service", async () => {
    const calls = api(true);
    const { PATCH } = await import("./mew/events/[id]/route");
    const context = (id: string) => ({ params: Promise.resolve({ id }) });
    const url = `/api/mew/events/${EVENT_ID}`;

    expect(
      (await PATCH(request("PATCH", url, { human_label: "explode" }), context(EVENT_ID))).status,
    ).toBe(400);
    expect(
      (await PATCH(request("PATCH", url, { human_label: "ignore" }), context("../x"))).status,
    ).toBe(404);
    const crossOrigin = request(
      "PATCH",
      url,
      { human_label: "ignore" },
      { origin: "https://evil.example" },
    );
    expect((await PATCH(crossOrigin, context(EVENT_ID))).status).toBe(403);
    expect(calls).toEqual([]);

    const ok = await PATCH(request("PATCH", url, { human_label: null }), context(EVENT_ID));
    expect(ok.status).toBe(204);
    expect(calls[0]).toEqual({
      path: `/v1/mew/events/${EVENT_ID}`,
      method: "PATCH",
      body: { human_label: null },
    });
  });

  it("lists with only the known filters", async () => {
    const calls = api(true);
    vi.stubGlobal(
      "fetch",
      vi.fn((url: URL) => {
        calls.push({ path: url.pathname + url.search, method: "GET", body: undefined });
        return Promise.resolve(Response.json({ events: [] }));
      }),
    );
    const { GET } = await import("./mew/events/route");

    await GET(
      new Request(`${ORIGIN}/api/mew/events?unlabeled=true&before=2026-10-21T10:00:00Z&evil=1`),
    );
    expect(calls.at(-1)?.path).toBe(
      "/v1/mew/events?unlabeled=true&before=2026-10-21T10%3A00%3A00Z",
    );
    const bad = await GET(new Request(`${ORIGIN}/api/mew/events?before=yesterday`));
    expect(bad.status).toBe(400);
  });
});
