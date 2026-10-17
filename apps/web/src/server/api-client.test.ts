import { ApiHealth } from "@mew/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SECRET = "s".repeat(32);

describe("apiFetch", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("API_BASE_URL", "http://api.internal:8000");
    vi.stubEnv("INTERNAL_API_SECRET", SECRET);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  async function load() {
    return import("./api-client");
  }

  it("sends the internal secret and bearer token, and refuses redirects", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(Response.json({ status: "ok", service: "api", version: "1" }));
    vi.stubGlobal("fetch", fetchMock);
    const { apiFetch } = await load();

    await apiFetch("/health", ApiHealth, { token: "tok" });

    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    const headers = new Headers(init.headers);
    expect(url.toString()).toBe("http://api.internal:8000/health");
    expect(headers.get("X-Internal-Secret")).toBe(SECRET);
    expect(headers.get("Authorization")).toBe("Bearer tok");
    expect(init.redirect).toBe("error");
  });

  it("rejects protocol-relative paths that would leave the API origin", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { apiFetch, ApiError } = await load();

    await expect(apiFetch("//evil.example/steal", ApiHealth)).rejects.toBeInstanceOf(ApiError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces HTTP failures with their status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("nope", { status: 401 })));
    const { apiFetch } = await load();

    await expect(apiFetch("/v1/me", ApiHealth)).rejects.toMatchObject({ status: 401 });
  });

  it("rejects responses that do not match the schema", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ status: "weird" })));
    const { apiFetch } = await load();

    await expect(apiFetch("/health", ApiHealth)).rejects.toThrow(/schema/);
  });

  it("refuses to run with a short internal secret", async () => {
    vi.stubEnv("INTERNAL_API_SECRET", "short");
    vi.stubGlobal("fetch", vi.fn());
    const { apiFetch } = await load();

    await expect(apiFetch("/health", ApiHealth)).rejects.toThrow(/INTERNAL_API_SECRET/);
  });
});
