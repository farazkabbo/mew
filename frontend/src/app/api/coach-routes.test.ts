import type { CoachReply } from "@mew/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { jpegBase64 } from "../../../test/jpeg";
import type * as CoachRun from "@/server/coach/run";

/** Coach mode (S4): the desktop app's routes, with the coaching flow itself mocked. */
const ORIGIN = "http://localhost:3000";
const TOKEN = `mewdt_${"A".repeat(43)}`;
const WALKTHROUGH = "11111111-1111-4111-8111-111111111111";
const DEVICE = {
  userId: "local",
  deviceId: "22222222-2222-4222-8222-222222222222",
  scopes: ["screen"],
};
const IMAGE = { jpeg: jpegBase64(1600, 900), width: 1600, height: 900 };
const SCENE = { app: "excel.exe", scope: "monitor", image: IMAGE };
const REPLY: CoachReply = {
  walkthroughId: WALKTHROUGH,
  title: "Pivot tables",
  status: "active",
  phase: "awaiting",
  step: 1,
  total: 5,
  hintsUsed: 0,
  speech: "Let's make a pivot table together. Click Insert, at the top.",
  actions: [],
};

const coaching = {
  startCoaching: vi.fn(() => Promise.resolve(REPLY)),
  resumeCoaching: vi.fn(() => Promise.resolve(REPLY)),
  stepCoaching: vi.fn(() => Promise.resolve(REPLY)),
  walkthroughContext: vi.fn(() =>
    Promise.resolve({ title: "Pivot tables", step: 2, instruction: "Click PivotTable." }),
  ),
};
const asked = vi.fn();

/** The API service: `verify` answers with `verifyStatus`. */
function api(verifyStatus = 200) {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: URL) =>
      Promise.resolve(
        url.pathname === "/v1/devices/verify" && verifyStatus === 200
          ? Response.json(DEVICE)
          : new Response(null, { status: verifyStatus === 200 ? 204 : verifyStatus }),
      ),
    ),
  );
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

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("INTERNAL_API_SECRET", "s".repeat(40));
  vi.stubEnv("GEMINI_API_KEY", "test-key");
  for (const fn of Object.values(coaching)) fn.mockClear();
  asked.mockClear();
  vi.doMock("@/server/coach/run", async (original) => ({
    ...(await original<typeof CoachRun>()),
    ...coaching,
  }));
  vi.doMock("@/server/screen-tutor", () => ({
    runScreenTutor: async function* (question: unknown) {
      asked(question);
      await Promise.resolve();
      yield { type: "speech", text: "It summarises data.", latencyMs: 1 };
    },
  }));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.doUnmock("@/server/coach/run");
  vi.doUnmock("@/server/screen-tutor");
});

describe("POST /api/screen/coach/start", () => {
  it("starts a walkthrough for a valid device and answers with step 1", async () => {
    api();
    const { POST } = await import("./screen/coach/start/route");
    const response = await POST(request("/api/screen/coach/start", { goal: "teach me", ...SCENE }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(REPLY);
    expect(coaching.startCoaching).toHaveBeenCalledOnce();
  });

  it("needs an active device token", async () => {
    api();
    const { POST } = await import("./screen/coach/start/route");
    const body = { goal: "teach me", ...SCENE };
    expect((await POST(request("/api/screen/coach/start", body, null))).status).toBe(401);
    expect((await POST(request("/api/screen/coach/start", body, "Bearer x"))).status).toBe(401);
    api(401);
    const revoked = await import("./screen/coach/start/route");
    expect((await revoked.POST(request("/api/screen/coach/start", body))).status).toBe(401);
    expect(coaching.startCoaching).not.toHaveBeenCalled();
  });

  it("refuses malformed bodies and images that aren't JPEGs", async () => {
    api();
    const { POST } = await import("./screen/coach/start/route");
    for (const body of [
      "not json",
      { goal: "", ...SCENE },
      { goal: "teach me", ...SCENE, app: "C:\\evil.exe" },
      { goal: "teach me", ...SCENE, image: { ...IMAGE, jpeg: btoa("<svg/>") } },
    ]) {
      const response = await POST(request("/api/screen/coach/start", body));
      expect(response.status, JSON.stringify(body).slice(0, 60)).toBe(400);
    }
    expect(coaching.startCoaching).not.toHaveBeenCalled();
  });

  it("is rate limited: 4 a minute", async () => {
    api();
    const { POST } = await import("./screen/coach/start/route");
    const statuses = [];
    for (let i = 0; i < 5; i++) {
      const response = await POST(request("/api/screen/coach/start", { goal: "go", ...SCENE }));
      statuses.push(response.status);
    }
    expect(statuses).toEqual([200, 200, 200, 200, 429]);
  });

  it("answers 503 without a model, and 429 when the model is busy", async () => {
    api();
    vi.stubEnv("GEMINI_API_KEY", "");
    const { POST } = await import("./screen/coach/start/route");
    const body = { goal: "teach me", ...SCENE };
    expect((await POST(request("/api/screen/coach/start", body))).status).toBe(503);

    vi.stubEnv("GEMINI_API_KEY", "test-key");
    const { ModelBusyError } = await import("@/server/gemini");
    coaching.startCoaching.mockRejectedValueOnce(new ModelBusyError("m", 1000));
    const busy = await POST(request("/api/screen/coach/start", body));
    expect(busy.status).toBe(429);
    coaching.startCoaching.mockRejectedValueOnce(new Error("secret upstream detail"));
    const failed = await POST(request("/api/screen/coach/start", body));
    expect(failed.status).toBe(502);
    expect(await failed.text()).not.toContain("secret upstream detail");
  });
});

describe("POST /api/screen/coach/step", () => {
  it("needs a screenshot to check a step", async () => {
    api();
    const { POST } = await import("./screen/coach/step/route");
    const done = await POST(
      request("/api/screen/coach/step", { walkthroughId: WALKTHROUGH, event: "done", ...SCENE }),
    );
    expect(done.status).toBe(200);
    const missing = await POST(
      request("/api/screen/coach/step", { walkthroughId: WALKTHROUGH, event: "done" }),
    );
    expect(missing.status).toBe(400);
  });

  it("works without a model for events that call none, and refuses checks", async () => {
    api();
    vi.stubEnv("GEMINI_API_KEY", "");
    const { POST } = await import("./screen/coach/step/route");
    for (const event of ["yes", "pause", "stop"]) {
      const response = await POST(
        request("/api/screen/coach/step", { walkthroughId: WALKTHROUGH, event }),
      );
      expect(response.status, event).toBe(200);
    }
    const unchecked = await POST(
      request("/api/screen/coach/step", { walkthroughId: WALKTHROUGH, event: "stuck", ...SCENE }),
    );
    expect(unchecked.status).toBe(503);
  });

  it("passes on 404 and 409 from the coaching flow", async () => {
    api();
    const { HttpError } = await import("@/server/http-error");
    const { POST } = await import("./screen/coach/step/route");
    coaching.stepCoaching.mockRejectedValueOnce(new HttpError(404, "Not found"));
    const body = { walkthroughId: WALKTHROUGH, event: "stop" };
    expect((await POST(request("/api/screen/coach/step", body))).status).toBe(404);
    coaching.stepCoaching.mockRejectedValueOnce(new HttpError(409, "Moved on"));
    expect((await POST(request("/api/screen/coach/step", body))).status).toBe(409);
  });

  it("is rate limited: 20 a minute, shared with resuming", async () => {
    api();
    const step = await import("./screen/coach/step/route");
    const resume = await import("./screen/coach/resume/route");
    for (let i = 0; i < 19; i++) {
      await step.POST(
        request("/api/screen/coach/step", { walkthroughId: WALKTHROUGH, event: "stop" }),
      );
    }
    expect((await resume.POST(request("/api/screen/coach/resume", SCENE))).status).toBe(200);
    expect((await resume.POST(request("/api/screen/coach/resume", SCENE))).status).toBe(429);
  });
});

describe("POST /api/screen/ask during a walkthrough", () => {
  it("answers with the walkthrough's current step as context", async () => {
    api();
    const { POST } = await import("./screen/ask/route");
    const ask = { transcript: "what's a pivot table?", ...SCENE, walkthroughId: WALKTHROUGH };
    const response = await POST(request("/api/screen/ask", ask));
    expect(response.status).toBe(200);
    await response.text();
    expect(coaching.walkthroughContext).toHaveBeenCalledWith(expect.anything(), WALKTHROUGH);
    expect(asked).toHaveBeenCalledWith(
      expect.objectContaining({
        walkthrough: { title: "Pivot tables", step: 2, instruction: "Click PivotTable." },
      }),
    );
  });

  it("looks nothing up for an ordinary question", async () => {
    api();
    const { POST } = await import("./screen/ask/route");
    const response = await POST(request("/api/screen/ask", { transcript: "hi", ...SCENE }));
    await response.text();
    expect(coaching.walkthroughContext).not.toHaveBeenCalled();
    expect(asked).toHaveBeenCalledWith(
      expect.not.objectContaining({ walkthrough: expect.anything() }),
    );
  });
});
