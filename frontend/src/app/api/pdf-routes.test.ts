import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** K4's "Recognize text" on a scanned page, in local mode (no Clerk keys). */
const ORIGIN = "http://localhost:3000";
const PDF = "77777777-7777-4777-8777-777777777777";

const recognize = (id: string, index: string, origin = ORIGIN) =>
  [
    new Request(`${ORIGIN}/api/pdfs/${id}/pages/${index}/recognize`, {
      method: "POST",
      headers: { origin },
    }),
    { params: Promise.resolve({ id, index }) },
  ] as const;

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("INTERNAL_API_SECRET", "s".repeat(40));
  vi.stubEnv("GEMINI_API_KEY", "test-key");
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.doUnmock("@/server/pdf-ocr");
});

describe("POST /api/pdfs/[id]/pages/[index]/recognize", () => {
  it("reads the page the API service drew, as the student", async () => {
    const fetchMock = vi.fn<(url: URL, init: RequestInit) => Promise<Response>>(() =>
      Promise.resolve(
        new Response(new Uint8Array([137, 80, 78, 71]), {
          headers: { "Content-Type": "image/png" },
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const read = vi.fn(() => Promise.resolve({ text: "3.4 Projectile motion" }));
    vi.doMock("@/server/pdf-ocr", () => ({ recognizePdfPage: read }));
    const { POST } = await import("./pdfs/[id]/pages/[index]/recognize/route");

    const response = await POST(...recognize(PDF, "3"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ text: "3.4 Projectile motion" });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toContain(`/v1/pdfs/${PDF}/pages/3/image`);
    expect(new Headers(init?.headers).get("X-Mew-Local-User")).toBe("local");
    expect(read).toHaveBeenCalledOnce();
  });

  it("refuses bad ids and other origins before anything is drawn or read", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { POST } = await import("./pdfs/[id]/pages/[index]/recognize/route");

    expect((await POST(...recognize("x", "3"))).status).toBe(404);
    expect((await POST(...recognize(PDF, "-1"))).status).toBe(404);
    expect((await POST(...recognize(PDF, "3", "https://x.io"))).status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
