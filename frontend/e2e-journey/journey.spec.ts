import { createHash, randomBytes } from "node:crypto";

import { type APIRequestContext, expect, type Page, test } from "@playwright/test";

/**
 * The launch journey (docs/LAUNCH_LIMITS.md): Ayesha finds neb, connects the desktop app, asks,
 * runs out, can't get around it, and signs her computer out. The desktop app's native parts
 * (installing, the neb:// link, the keychain) are the manual checklist; here the app is played
 * by its HTTP calls, exactly as it makes them (docs/DESKTOP_API.md). The model is the fake one.
 */

const remote = Boolean(process.env.JOURNEY_BASE_URL);
const site = process.env.JOURNEY_SITE_URL;
const DEVICE = "1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d";

const base64url = (bytes: Buffer) => bytes.toString("base64url");

/** A small real JPEG, made by the browser (the routes check it's one). */
async function jpeg(page: Page): Promise<string> {
  await page.goto("about:blank");
  return page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 180;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no canvas");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, 320, 180);
    ctx.fillStyle = "#000";
    ctx.fillText("3x + 7 = 19", 20, 90);
    return canvas.toDataURL("image/jpeg", 0.8).split(",")[1] ?? "";
  });
}

/** Step 5, as the desktop app: PKCE, the signed-in page's code, the exchange. Local mode only. */
async function connect(request: APIRequestContext, baseURL: string): Promise<string> {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  const origin = { Origin: baseURL };
  const link = await request.post("/api/devices/link", { data: { challenge }, headers: origin });
  expect(link.status()).toBe(200);
  const { code } = (await link.json()) as { code: string };
  const exchanged = await request.post("/api/devices/exchange", {
    data: { code, verifier, deviceName: "Ayesha's PC" },
  });
  expect(exchanged.status()).toBe(200);
  // A code works once.
  const again = await request.post("/api/devices/exchange", {
    data: { code, verifier, deviceName: "Ayesha's PC" },
  });
  expect(again.status()).toBe(400);
  return ((await exchanged.json()) as { token: string }).token;
}

test("Ayesha's journey, steps 1 to 12", async ({ page, request, baseURL }) => {
  // 1–2. The front door: "Get neb" goes to the public download page, no account needed.
  if (site) {
    const home = await request.get(site);
    expect(await home.text()).toContain(`${site.replace(/\/$/, "")}/download`);
    const windows = await request.get(`${site}/download`, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
    });
    expect(await windows.text()).toContain("Already have an account?");
    const mac = await request.get(`${site}/download`, {
      headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)" },
    });
    expect(await mac.text()).toContain("Windows-only for now");
  }

  // 3–5. Installed, signed in through the browser: the app holds a device token.
  const token = remote
    ? (process.env.JOURNEY_DEVICE_TOKEN ?? "")
    : await connect(request, baseURL ?? "http://localhost:3200");
  expect(token).toMatch(/^mewdt_/);
  const app = { Authorization: `Bearer ${token}`, "X-Neb-Device": DEVICE };

  // Polling (the fallback when neb:// is blocked): nothing finished for an unknown verifier yet.
  if (remote) {
    const poll = await request.post("/api/devices/poll", {
      data: { verifier: base64url(randomBytes(32)), deviceName: "x" },
    });
    expect(poll.status()).toBe(202);
  }

  const image = await jpeg(page);
  const ask = (transcript: string) =>
    request.post("/api/screen/ask", {
      headers: app,
      data: {
        transcript,
        app: "excel.exe",
        scope: "window",
        image: { jpeg: image, width: 320, height: 180 },
      },
    });
  const left = async () =>
    (
      (await (await request.get("/api/screen/quota", { headers: app })).json()) as {
        remaining: number;
      }
    ).remaining;

  // 6. The first question: answered, and 7 left.
  const first = await ask("where is the pivot table button?");
  expect(first.status()).toBe(200);
  expect(await first.text()).toContain('"type":"speech"');
  expect(first.headers()["x-neb-questions-left"]).toBe("7");

  // 7. A follow-up in the same circle session is free.
  const circle = (sessionId: string, question: string) =>
    request.post("/api/screen/circle-ask", {
      headers: app,
      data: {
        sessionId,
        question: { source: "voice", text: question },
        marks: [
          {
            number: 1,
            kind: "circle",
            box: { left: 50, top: 400, right: 400, bottom: 600 },
            polygon: [],
            text: "3x + 7 = 19",
          },
        ],
        focus: { image: { jpeg: image, width: 320, height: 180 }, widthPx: 320, heightPx: 180 },
        context: { jpeg: image, width: 320, height: 180 },
        blocks: [],
        app: "msedge.exe",
        kind: "browser",
        history: [],
      },
    });
  const session = crypto.randomUUID();
  expect((await circle(session, "explain")).status()).toBe(200);
  expect(await left()).toBe(6);
  expect((await circle(session, "and the next step?")).status()).toBe(200);
  expect(await left()).toBe(6);

  // 8. A hiccup before any answer gives the question back.
  const failed = await ask("FAKE_FAIL what is this?");
  expect(failed.status()).toBe(200);
  expect(await failed.text()).toContain('"type":"error"');
  expect(await left()).toBe(6);

  // 9. Down to 0, then the out-of-questions message (the 2-left notice is the app's, by hand).
  for (let i = 0; i < 6; i++) expect((await ask(`question ${i}`)).status()).toBe(200);
  expect(await left()).toBe(0);
  const refused = await ask("one more?");
  expect(refused.status()).toBe(429);
  const body = (await refused.json()) as { code: string; error: string };
  expect(body.code).toBe("QUOTA_EXCEEDED");
  expect(body.error).toContain("free questions");
  // The notebook still works at 0.
  expect((await request.get("/notebook")).status()).toBe(200);

  // 10. Getting around it fails: 50 at once never get one more through.
  const burst = await Promise.all(Array.from({ length: 50 }, (_, i) => ask(`burst ${i}`)));
  expect(burst.filter((r) => r.status() === 200)).toHaveLength(0);
  expect(await left()).toBe(0);

  // 11. The day's cap and the kill switch are unit-tested (question-gate.test.ts): they need the
  //     server's environment changed mid-run.

  // 12. Signing this computer out: the next request is refused at once.
  expect((await request.post("/api/devices/revoke-self", { headers: app })).status()).toBe(204);
  expect((await ask("still there?")).status()).toBe(401);
});
