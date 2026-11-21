import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as Gemini from "@/server/gemini";

/** The cursor modes' plan (docs/CURSOR_MODES.md), in local mode as in development. */
const ORIGIN = "http://localhost:3000";
const TOKEN = `mewdt_${"A".repeat(43)}`;
const DEVICE = {
  userId: "local",
  deviceId: "22222222-2222-4222-8222-222222222222",
  scopes: ["screen"],
};
const PLAN_ID = "44444444-4444-4444-8444-444444444444";
const SHOW = {
  mode: "show",
  request: "how do I turn on dark mode?",
  app: "systemsettings.exe",
  controls: [{ type: "ListItem", name: "Personalization" }],
};

let made: unknown;
const prompts: string[] = [];

function api(): string[] {
  const paths: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: URL) => {
      paths.push(url.pathname);
      return Promise.resolve(
        url.pathname === "/v1/devices/verify"
          ? Response.json(DEVICE)
          : new Response(null, { status: 204 }),
      );
    }),
  );
  return paths;
}

function request(body: unknown, headers: Record<string, string> = {}) {
  return new Request(`${ORIGIN}/api/screen/plan`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...headers },
  });
}

const bearer = { authorization: `Bearer ${TOKEN}` };

beforeEach(() => {
  vi.resetModules();
  prompts.length = 0;
  vi.stubEnv("INTERNAL_API_SECRET", "s".repeat(40));
  vi.stubEnv("GEMINI_API_KEY", "test-key");
  made = {
    speech: "Click Personalization, then Colors.",
    steps: [
      { type: "ListItem", name: "Personalization" },
      { type: "ListItem", name: "Colors" },
    ],
    action: { type: "open_setting", page: "colors" },
  };
  vi.doMock("@/server/gemini", async (original) => ({
    ...(await original<typeof Gemini>()),
    generateStructured: (req: { input: { text?: string }[] }) => {
      prompts.push(req.input.map((i) => i.text ?? "").join(""));
      return Promise.resolve(made);
    },
  }));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.doUnmock("@/server/gemini");
});

describe("POST /api/screen/plan", () => {
  it("answers SHOW ME with a path and no action", async () => {
    api();
    const { POST } = await import("./screen/plan/route");
    const response = await POST(request(SHOW, bearer));
    expect(response.status).toBe(200);
    const reply = (await response.json()) as { planId: string; steps: unknown[]; action: null };
    expect(reply.steps).toHaveLength(2);
    expect(reply.action).toBeNull();
    expect(reply.planId).toMatch(/^[0-9a-f-]{36}$/);
    // Only the words and the control names went to the model.
    expect(prompts[0]).toContain("Personalization");
    expect(prompts[0]).not.toContain("image");
  });

  it("answers DO IT with the action only, and keeps a re-plan's id", async () => {
    api();
    const { POST } = await import("./screen/plan/route");
    const response = await POST(request({ ...SHOW, mode: "do", planId: PLAN_ID }, bearer));
    const reply = (await response.json()) as { planId: string; steps: unknown[]; action: unknown };
    expect(reply).toMatchObject({ planId: PLAN_ID, steps: [], action: { page: "colors" } });
  });

  it("drops a plan that fails the safety check", async () => {
    api();
    made = {
      speech: "Open the Registry Editor and change this.",
      steps: [{ type: "Button", name: "Install" }],
      action: null,
    };
    const { POST } = await import("./screen/plan/route");
    const reply = (await (await POST(request(SHOW, bearer))).json()) as { steps: unknown[] };
    expect(reply.steps).toEqual([]);
  });

  it.each([
    ["content controls", { ...SHOW, controls: [{ type: "Edit", name: "Dear Sam" }] }],
    ["a screenshot", { ...SHOW, image: { jpeg: "abc", width: 1, height: 1 } }],
    ["a long request", { ...SHOW, request: "x".repeat(301) }],
  ])("refuses %s", async (_, body) => {
    api();
    const { POST } = await import("./screen/plan/route");
    const response = await POST(request(body, bearer));
    expect(response.status).toBe(400);
    expect(prompts).toEqual([]);
  });

  it("refuses a request without a device token, without asking anything", async () => {
    const paths = api();
    const { POST } = await import("./screen/plan/route");
    const response = await POST(request(SHOW));
    expect(response.status).toBe(401);
    expect(paths).toEqual([]);
  });
});

describe("POST /api/screen/recipe", () => {
  const BODY = {
    url: "https://food.example/khichuri",
    title: "Khichuri",
    text: "Bhuna khichuri. 1 cup rice, half a cup of lentils. Wash the rice, then cook.",
  };

  it("structures a page's text into a recipe", async () => {
    api();
    made = {
      found: true,
      title: "Spiced rice and lentils",
      originalTitle: "ভুনা খিচুড়ি",
      ingredients: ["1 cup rice"],
      steps: ["Wash the rice."],
      servings: null,
      time: null,
    };
    const { POST } = await import("./screen/recipe/route");
    const response = await POST(
      new Request(`${ORIGIN}/api/screen/recipe`, {
        method: "POST",
        body: JSON.stringify(BODY),
        headers: { "content-type": "application/json", ...bearer },
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ found: true, originalTitle: "ভুনা খিচুড়ি" });
    expect(prompts[0]).toContain("khichuri");
  });

  it("refuses extra fields such as a picture", async () => {
    api();
    const { POST } = await import("./screen/recipe/route");
    const response = await POST(
      new Request(`${ORIGIN}/api/screen/recipe`, {
        method: "POST",
        body: JSON.stringify({ ...BODY, image: "x" }),
        headers: { "content-type": "application/json", ...bearer },
      }),
    );
    expect(response.status).toBe(400);
    expect(prompts).toEqual([]);
  });
});
