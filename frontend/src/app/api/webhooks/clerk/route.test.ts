import { createHmac } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as ApiClient from "@/server/api-client";

vi.mock("server-only", () => ({}));

const calls = vi.hoisted(() => [] as { path: string; body: unknown }[]);
vi.mock("@/server/api-client", async (original) => ({
  ...(await original<typeof ApiClient>()),
  apiFetch: vi.fn(async (path: string, _schema: unknown, options: { body?: unknown }) => {
    calls.push({ path, body: options.body });
    return undefined;
  }),
}));

const SECRET = `whsec_${Buffer.from("a test webhook secret").toString("base64")}`;

function signed(body: object, { secret = SECRET, at = Date.now() } = {}) {
  const text = JSON.stringify(body);
  const timestamp = String(Math.floor(at / 1000));
  const key = Buffer.from(secret.slice("whsec_".length), "base64");
  const signature = createHmac("sha256", key).update(`msg_1.${timestamp}.${text}`).digest("base64");
  return new Request("http://localhost:3000/api/webhooks/clerk", {
    method: "POST",
    body: text,
    headers: {
      "svix-id": "msg_1",
      "svix-timestamp": timestamp,
      "svix-signature": `v1,${signature}`,
    },
  });
}

beforeEach(() => {
  calls.length = 0;
  vi.stubEnv("CLERK_WEBHOOK_SECRET", SECRET);
});
afterEach(() => vi.unstubAllEnvs());

describe("Clerk's webhooks", () => {
  it("gives a new learner their allowance", async () => {
    const { POST } = await import("./route");
    const response = await POST(signed({ type: "user.created", data: { id: "user_ayesha" } }));
    expect(response.status).toBe(200);
    expect(calls).toEqual([
      { path: "/v1/quota/ensure", body: { userId: "user_ayesha", limit: 8 } },
    ]);
  });

  it("signs a deleted account out of every computer", async () => {
    const { POST } = await import("./route");
    await POST(signed({ type: "user.deleted", data: { id: "user_ayesha" } }));
    expect(calls).toEqual([{ path: "/v1/devices/revoke-user", body: { userId: "user_ayesha" } }]);
  });

  it("refuses a bad signature, another secret, or an old replay", async () => {
    const { POST } = await import("./route");
    const event = { type: "user.deleted", data: { id: "user_ayesha" } };
    const forged = signed(event, { secret: `whsec_${Buffer.from("other").toString("base64")}` });
    expect((await POST(forged)).status).toBe(401);
    const stale = signed(event, { at: Date.now() - 10 * 60_000 });
    expect((await POST(stale)).status).toBe(401);
    const unsigned = new Request("http://localhost:3000/api/webhooks/clerk", {
      method: "POST",
      body: JSON.stringify(event),
    });
    expect((await POST(unsigned)).status).toBe(401);
    expect(calls).toEqual([]);
  });

  it("ignores events it doesn't act on, like session.revoked", async () => {
    const { POST } = await import("./route");
    const response = await POST(signed({ type: "session.revoked", data: { id: "sess_1" } }));
    expect(await response.json()).toEqual({ ok: true, ignored: true });
    expect(calls).toEqual([]);
  });
});
