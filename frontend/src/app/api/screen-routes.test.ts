import type { ScreenStreamEvent } from "@mew/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { jpegBase64 } from "../../../test/jpeg";

/** Screen Coach S2: desktop sign-in and asking about the screen (local mode, as in development). */
const ORIGIN = "http://localhost:3000";
const TOKEN = `mewdt_${"A".repeat(43)}`;
const DEVICE = {
  userId: "local",
  deviceId: "22222222-2222-4222-8222-222222222222",
  scopes: ["screen"],
};
const ASK = {
  transcript: "what does this button do?",
  app: "excel.exe",
  scope: "window",
  image: { jpeg: jpegBase64(1600, 900), width: 1600, height: 900 },
};
const EVENTS: ScreenStreamEvent[] = [
  { type: "speech", text: "That inserts a chart.", latencyMs: 400 },
  {
    type: "response",
    response: { speech: "That inserts a chart.", actions: [], mode: "answer" },
    turnId: "33333333-3333-4333-8333-333333333333",
    latencyMs: 900,
  },
];

const CLIP_ID = "55555555-5555-4555-8555-555555555555";
const CLIP = {
  image: { jpeg: jpegBase64(1200, 600), width: 1200, height: 600 },
  pixelRatio: 1.5,
  strokes: [
    {
      tool: "pen",
      color: "#8a7bf0",
      width: 3,
      points: [
        [10, 10, 0.5, 0],
        [20, 12, 0.5, 16],
      ],
    },
  ],
  source: { app: "msedge.exe", title: "Worksheet", capturedAt: "2026-10-22T10:00:00.000Z" },
  ocrText: "Question 3",
};
const CLIP_VIEW = {
  id: CLIP_ID,
  width: 1200,
  height: 600,
  pixelRatio: 1.5,
  strokes: CLIP.strokes,
  source: CLIP.source,
  ocrText: "Question 3",
  notebookPageId: null,
  entry: null,
  createdAt: "2026-10-22T10:00:01.000+00:00",
};
const REANCHOR = {
  app: "msedge.exe",
  scope: "window",
  focus: { kind: "question", text: "Question 3" },
  previous: [{ type: "underline", box: { left: 1, top: 2, right: 3, bottom: 4 } }],
  image: { jpeg: jpegBase64(1600, 900), width: 1600, height: 900 },
};

type Call = { path: string; body: unknown; headers: Headers };

/** The API service: `verify` answers with `verifyStatus`; other calls succeed. */
function api(verifyStatus = 200): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: URL, init: RequestInit) => {
      const body = typeof init.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
      calls.push({ path: url.pathname, body, headers: new Headers(init.headers) });
      switch (url.pathname) {
        case "/v1/devices/verify":
          return Promise.resolve(
            verifyStatus === 200
              ? Response.json(DEVICE)
              : new Response(null, { status: verifyStatus }),
          );
        case "/v1/devices/link-codes":
          return Promise.resolve(Response.json({ code: "c".repeat(32), expiresInS: 60 }));
        case "/v1/devices/exchange":
          return Promise.resolve(Response.json({ token: TOKEN, deviceId: DEVICE.deviceId }));
        case "/v1/clips":
          return Promise.resolve(Response.json({ clipId: CLIP_ID }, { status: 201 }));
        case `/v1/clips/${CLIP_ID}`:
          return Promise.resolve(Response.json(CLIP_VIEW));
        case `/v1/clips/${CLIP_ID}/image`:
          return Promise.resolve(
            new Response(Buffer.from(jpegBase64(10, 10), "base64"), {
              headers: { "content-type": "image/jpeg" },
            }),
          );
        default:
          return Promise.resolve(new Response(null, { status: 204 }));
      }
    }),
  );
  return calls;
}

function request(url: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(`${ORIGIN}${url}`, {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "content-type": "application/json", ...headers },
  });
}

const bearer = (token = TOKEN) => ({ authorization: `Bearer ${token}` });

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("INTERNAL_API_SECRET", "s".repeat(40));
  vi.stubEnv("GEMINI_API_KEY", "test-key");
  vi.doMock("@/server/screen-tutor", () => ({
    runScreenTutor: async function* () {
      await Promise.resolve();
      yield* EVENTS;
    },
  }));
  vi.doMock("@/server/screen-reanchor", () => ({
    reanchorScreen: () => Promise.resolve({ found: true, actions: REANCHOR.previous }),
  }));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.doUnmock("@/server/screen-tutor");
  vi.doUnmock("@/server/screen-reanchor");
});

describe("POST /api/screen/ask", () => {
  it("streams the spoken reply, then the full response, for a valid device", async () => {
    const calls = api();
    const { POST } = await import("./screen/ask/route");

    const response = await POST(request("/api/screen/ask", ASK, bearer()));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/x-ndjson");
    const lines = (await response.text())
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as unknown);
    expect(lines).toEqual(EVENTS);
    expect(calls[0]).toMatchObject({ path: "/v1/devices/verify", body: { token: TOKEN } });
    expect(calls[0]?.headers.get("x-internal-secret")).toBe("s".repeat(40));
  });

  it.each([
    ["no token", {}],
    ["a malformed token", bearer("mewdt_short")],
    ["a Clerk-style token", { authorization: "Bearer eyJhbGciOi.x.y" }],
  ])("refuses %s without asking the API", async (_, headers) => {
    const calls = api();
    const { POST } = await import("./screen/ask/route");

    const response = await POST(request("/api/screen/ask", ASK, headers));

    expect(response.status).toBe(401);
    expect(calls).toEqual([]);
  });

  it("refuses a revoked device", async () => {
    api(401);
    const { POST } = await import("./screen/ask/route");
    const response = await POST(request("/api/screen/ask", ASK, bearer()));
    expect(response.status).toBe(401);
  });

  it("refuses an image that isn't a JPEG", async () => {
    api();
    const { POST } = await import("./screen/ask/route");
    const png = {
      ...ASK,
      image: { ...ASK.image, jpeg: Buffer.from("\x89PNG....").toString("base64") },
    };
    const response = await POST(request("/api/screen/ask", png, bearer()));
    expect(response.status).toBe(400);
  });

  it("refuses an app given as a path, and oversized bodies", async () => {
    api();
    const { POST } = await import("./screen/ask/route");
    const path = await POST(
      request("/api/screen/ask", { ...ASK, app: "C:\\x\\excel.exe" }, bearer()),
    );
    expect(path.status).toBe(400);
    const huge = await POST(request("/api/screen/ask", "x".repeat(1_600_000), bearer()));
    expect(huge.status).toBe(413);
  });

  it("answers 503 (before streaming) when the model isn't configured", async () => {
    api();
    vi.stubEnv("GEMINI_API_KEY", "");
    const { POST } = await import("./screen/ask/route");
    const response = await POST(request("/api/screen/ask", ASK, bearer()));
    expect(response.status).toBe(503);
  });
});

describe("desktop sign-in", () => {
  const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

  it("gives the signed-in page a link code for the desktop app's challenge", async () => {
    const calls = api();
    const { POST } = await import("./devices/link/route");

    const response = await POST(
      request("/api/devices/link", { challenge: CHALLENGE }, { origin: ORIGIN }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ code: "c".repeat(32), expiresInS: 60 });
    expect(calls[0]).toMatchObject({
      path: "/v1/devices/link-codes",
      body: { challenge: CHALLENGE },
    });
  });

  it("refuses link codes for other origins and malformed challenges", async () => {
    api();
    const { POST } = await import("./devices/link/route");
    const crossSite = await POST(
      request("/api/devices/link", { challenge: CHALLENGE }, { origin: "https://evil.example" }),
    );
    expect(crossSite.status).toBe(403);
    const bad = await POST(
      request("/api/devices/link", { challenge: "short" }, { origin: ORIGIN }),
    );
    expect(bad.status).toBe(400);
  });

  it("lets the desktop app redeem a code without a browser session", async () => {
    const calls = api();
    const { POST } = await import("./devices/exchange/route");

    const response = await POST(
      request("/api/devices/exchange", {
        code: "c".repeat(32),
        verifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
        deviceName: "DESKTOP-1",
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ token: TOKEN, deviceId: DEVICE.deviceId });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(calls[0]?.path).toBe("/v1/devices/exchange");
  });

  it("explains an expired code", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response(null, { status: 400 }))),
    );
    const { POST } = await import("./devices/exchange/route");
    const response = await POST(
      request("/api/devices/exchange", {
        code: "c".repeat(32),
        verifier: "v".repeat(43),
        deviceName: "DESKTOP-1",
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "That link has expired. Try again." });
  });

  it("lets a device sign itself out with its own token", async () => {
    const calls = api();
    const { POST } = await import("./devices/revoke-self/route");
    expect((await POST(request("/api/devices/revoke-self", {}, bearer()))).status).toBe(204);
    expect(calls[0]).toMatchObject({ path: "/v1/devices/revoke-self", body: { token: TOKEN } });
    expect((await POST(request("/api/devices/revoke-self", {}))).status).toBe(401);
  });

  it("revokes one device by id (and 404s anything that isn't an id)", async () => {
    const calls = api();
    const { POST } = await import("./devices/[id]/revoke/route");
    const params = (id: string) => ({ params: Promise.resolve({ id }) });

    const ok = await POST(
      request(`/api/devices/${DEVICE.deviceId}/revoke`, {}, { origin: ORIGIN }),
      params(DEVICE.deviceId),
    );
    expect(ok.status).toBe(204);
    expect(calls[0]?.path).toBe(`/v1/devices/${DEVICE.deviceId}/revoke`);

    const bad = await POST(
      request("/api/devices/../revoke", {}, { origin: ORIGIN }),
      params("../../v1/admin"),
    );
    expect(bad.status).toBe(404);
  });
});

describe("POST /api/screen/clips", () => {
  it("stores a clip for the device's user and answers with its id only", async () => {
    const calls = api();
    const { POST } = await import("./screen/clips/route");

    const response = await POST(request("/api/screen/clips", CLIP, bearer()));

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ clipId: CLIP_ID });
    const stored = calls.find((c) => c.path === "/v1/clips");
    // The API checks the device token itself; no user id is passed for it to trust.
    expect(stored?.headers.get("x-mew-device-token")).toBe(TOKEN);
    expect(stored?.body).not.toHaveProperty("userId");
  });

  it("refuses without a device, and for revoked devices", async () => {
    const calls = api();
    const { POST } = await import("./screen/clips/route");
    expect((await POST(request("/api/screen/clips", CLIP))).status).toBe(401);
    expect(calls).toEqual([]);
    api(401);
    expect((await POST(request("/api/screen/clips", CLIP, bearer()))).status).toBe(401);
  });

  it.each([
    ["an image of another size than claimed", { image: { ...CLIP.image, width: 1100 } }],
    [
      "an image that isn't a JPEG",
      { image: { ...CLIP.image, jpeg: Buffer.from("PNG....").toString("base64") } },
    ],
    [
      "ink far outside the image",
      { strokes: [{ ...CLIP.strokes[0], points: [[99_999, 10, 0.5, 0]] }] },
    ],
    [
      "a link that could carry a secret",
      { source: { ...CLIP.source, url: "https://example.com/?session=abc" } },
    ],
  ])("refuses %s", async (_, change) => {
    const calls = api();
    const { POST } = await import("./screen/clips/route");
    const response = await POST(request("/api/screen/clips", { ...CLIP, ...change }, bearer()));
    expect(response.status).toBe(400);
    expect(calls.some((c) => c.path === "/v1/clips")).toBe(false);
  });
});

describe("POST /api/screen/reanchor", () => {
  it("answers with the re-placed ink for a valid device", async () => {
    api();
    const { POST } = await import("./screen/reanchor/route");
    const response = await POST(request("/api/screen/reanchor", REANCHOR, bearer()));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ found: true, actions: REANCHOR.previous });
  });

  it("refuses without a device and with a non-JPEG image", async () => {
    api();
    const { POST } = await import("./screen/reanchor/route");
    expect((await POST(request("/api/screen/reanchor", REANCHOR))).status).toBe(401);
    const png = {
      ...REANCHOR,
      image: { ...REANCHOR.image, jpeg: Buffer.from("PNG....").toString("base64") },
    };
    expect((await POST(request("/api/screen/reanchor", png, bearer()))).status).toBe(400);
  });
});

describe("/api/clips/[id]", () => {
  const params = (id: string) => ({ params: Promise.resolve({ id }) });
  const get = (url: string) => new Request(`${ORIGIN}${url}`, { headers: { origin: ORIGIN } });

  it("reads a clip back as its owner (local mode) and serves its image as a JPEG only", async () => {
    api();
    const { GET } = await import("./clips/[id]/route");
    const clip = await GET(get(`/api/clips/${CLIP_ID}`), params(CLIP_ID));
    expect(clip.status).toBe(200);
    expect(await clip.json()).toEqual(CLIP_VIEW);

    const image = await import("./clips/[id]/image/route");
    const picture = await image.GET(get(`/api/clips/${CLIP_ID}/image`), params(CLIP_ID));
    expect(picture.status).toBe(200);
    expect(picture.headers.get("content-type")).toBe("image/jpeg");
    expect(picture.headers.get("cache-control")).toContain("no-store");
    expect(picture.headers.get("content-security-policy")).toContain("sandbox");
  });

  it("404s anything that isn't a clip id", async () => {
    const calls = api();
    const { GET } = await import("./clips/[id]/route");
    const response = await GET(get("/api/clips/x"), params("../../v1/admin"));
    expect(response.status).toBe(404);
    expect(calls).toEqual([]);
  });
});
