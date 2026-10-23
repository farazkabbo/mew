import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, type Page, test } from "./fixtures";

/**
 * Screen Coach S3's overlay pages (desktop/shell): the ink overlay, the ink pill and a clip's
 * preview, loaded in a real browser from the bundled files, with Tauri's bridge stubbed. They
 * check the planning, drawing and reporting end to end, and that each page's own CSP holds.
 * (The windows themselves, click-through and excluded from capture, need the desktop app.)
 */

const SHELL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../desktop/shell");
const ORIGIN = "http://tauri.test";

test.beforeAll(() => {
  execFileSync(process.execPath, [path.join(SHELL, "../scripts/build-shell.mjs")], {
    stdio: "ignore",
  });
});

type Call = { cmd: string; args: unknown };

/** Serves the shell's files and stubs `window.__TAURI__.core.invoke` (answers from `replies`). */
async function openShellPage(page: Page, file: string, replies: Record<string, unknown> = {}) {
  const violations: string[] = [];
  page.on("console", (message) => {
    if (/Content.Security.Policy|Refused to/i.test(message.text())) violations.push(message.text());
  });
  await page.route(`${ORIGIN}/**`, async (route) => {
    const name = new URL(route.request().url()).pathname.slice(1);
    const body = await readFile(path.join(SHELL, name)).catch(() => null);
    if (!body) return route.fulfill({ status: 404 });
    const type = name.endsWith(".html")
      ? "text/html"
      : name.endsWith(".css")
        ? "text/css"
        : "text/javascript";
    return route.fulfill({ contentType: type, body });
  });
  await page.addInitScript((answers) => {
    const calls: { cmd: string; args: unknown }[] = [];
    Object.assign(window, {
      __calls: calls,
      __TAURI__: {
        core: {
          invoke: (cmd: string, args: unknown) => {
            calls.push({ cmd, args });
            return Promise.resolve(answers[cmd] ?? null);
          },
        },
      },
    });
  }, replies);
  await page.goto(`${ORIGIN}/${file}`);
  return {
    violations,
    calls: () => page.evaluate(() => (window as unknown as { __calls: Call[] }).__calls),
    dispatch: (name: string, detail: unknown) =>
      page.evaluate(([n, d]) => window.dispatchEvent(new CustomEvent(n as string, { detail: d })), [
        name,
        detail,
      ] as const),
  };
}

/** Lines of "text" down a page column, as the desktop app sends OCR rectangles. */
const lines = (left: number, right: number) =>
  Array.from({ length: 18 }, (_, i) => [left, 40 + i * 40, right - left, 20]);

test("the ink overlay draws beside the text and reports what it drew", async ({ page }) => {
  const shell = await openShellPage(page, "ink-overlay.html");
  const box = (l: number, t: number, r: number, b: number) => ({
    left: l,
    top: t,
    right: r,
    bottom: b,
  });
  await shell.dispatch("mew:ink-draw", {
    id: 7,
    seed: "turn-7",
    actions: [
      { type: "focus_region", box: box(250, 300, 750, 420), kind: "question" },
      { type: "circle_region", box: box(300, 310, 450, 340) },
      {
        type: "margin_note",
        text: "Forces first",
        besideBox: box(250, 300, 750, 420),
        side: "auto",
      },
    ],
    frame: [0, 0, 1280, 800],
    bounds: [0, 0, 1280, 800],
    obstacles: lines(320, 960),
    textHeight: 20,
    scale: 1,
    colors: { ink: "#8a7bf0", highlight: "#8a7bf055" },
    animate: false,
  });

  await expect.poll(async () => (await shell.calls()).length).toBe(1);
  const [call] = await shell.calls();
  expect(call?.cmd).toBe("screen_ink_drawn");
  const ink = (
    call?.args as { ink: { id: number; strokes: { points: number[][] }[]; bbox: number[] } }
  ).ink;
  expect(ink.id).toBe(7);
  expect(ink.strokes.length).toBeGreaterThan(3);
  for (const stroke of ink.strokes)
    for (const point of stroke.points) expect(point).toHaveLength(4);
  // The note went into the right margin (the text column ends at 960).
  const rightmost = Math.max(...ink.strokes.flatMap((s) => s.points.map((p) => p[0] ?? 0)));
  expect(rightmost).toBeGreaterThan(960);

  // Violet ink is on the canvas.
  const violet = await page.locator("canvas").evaluate((canvas: HTMLCanvasElement) => {
    const data = canvas.getContext("2d")?.getImageData(0, 0, canvas.width, canvas.height).data;
    let count = 0;
    for (let i = 0; data && i < data.length; i += 4) {
      if ((data[i + 3] ?? 0) > 100 && (data[i] ?? 0) > 100 && (data[i + 2] ?? 0) > 200) count++;
    }
    return count;
  });
  expect(violet).toBeGreaterThan(200);

  await shell.dispatch("mew:ink-fade", {});
  await expect(page.locator("canvas")).toHaveClass(/faded/);
  expect(shell.violations).toEqual([]);
});

test("the ink overlay ignores malformed requests", async ({ page }) => {
  const shell = await openShellPage(page, "ink-overlay.html");
  await shell.dispatch("mew:ink-draw", { id: 1, actions: [{ type: "open_url", url: "x" }] });
  await page.waitForTimeout(200);
  expect(await shell.calls()).toEqual([]);
});

test("the pill's buttons call their commands", async ({ page }) => {
  const shell = await openShellPage(page, "ink-pill.html");
  await page.getByRole("button", { name: /Save to notebook/ }).click();
  expect(await shell.calls()).toEqual([{ cmd: "screen_ink_pill", args: { action: "save" } }]);
  await expect(page.getByRole("button", { name: /Clear/ })).toBeDisabled();
  expect(shell.violations).toEqual([]);
});

test("the clip preview shows the picture from mewclip:// and saves only the crop and choices", async ({
  page,
}) => {
  let pictureServed = false;
  await page.route("http://mewclip.localhost/**", async (route) => {
    pictureServed = true;
    const tiny = Buffer.from(
      "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP////////////////////////////////////////////////////////////////////////////////////8AAEQgAAQABAwEiAAIRAQMRAf/EABQAAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AD+AP//Z",
      "base64",
    );
    return route.fulfill({ contentType: "image/jpeg", body: tiny });
  });
  const shell = await openShellPage(page, "clip-preview.html", {
    screen_clip_ready: {
      imageUrl: "http://mewclip.localhost/0123456789abcdef0123456789abcdef/frame.jpg",
      frame: [1600, 900],
      crop: [100, 100, 600, 300],
      strokes: [
        {
          tool: "pen",
          color: "#8a7bf0",
          width: 3,
          points: [
            [120, 120, 0.5, 0],
            [300, 150, 0.5, 30],
          ],
        },
      ],
      cards: [],
      source: {
        app: "msedge.exe",
        title: "Lecture 5",
        link: "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=754",
        includeLink: true,
      },
      expiresInMs: 60_000,
    },
  });
  await shell.dispatch("mew:clip-open", {});

  await expect(page.locator("#source")).toHaveText("msedge · Lecture 5");
  await expect(page.locator("#link")).toHaveText(
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=754",
  );
  await expect.poll(() => pictureServed).toBe(true);
  await expect(page.locator("#marks rect.crop")).toHaveCount(1);
  await expect(page.locator("#marks path[fill='#8a7bf0']")).toHaveCount(1);
  await expect(page.locator("#include-link")).toBeChecked();

  await page.locator("#include-notes").uncheck();
  await expect(page.locator("#marks path[fill='#8a7bf0']")).toHaveCount(0);
  await page.getByRole("button", { name: "Save" }).click();
  const save = (await shell.calls()).find((c) => c.cmd === "screen_clip_save");
  expect(save?.args).toEqual({
    crop: [100, 100, 600, 300],
    includeNotes: false,
    includeLink: true,
  });
  expect(shell.violations).toEqual([]);
});

test("the clip preview refuses an image from anywhere but mewclip://", async ({ page }) => {
  const shell = await openShellPage(page, "clip-preview.html", {
    screen_clip_ready: {
      imageUrl: "https://evil.example/frame.jpg",
      frame: [100, 100],
      crop: null,
      strokes: [],
      cards: [],
      source: { app: "x.exe", title: null, link: null, includeLink: false },
      expiresInMs: 1000,
    },
  });
  await shell.dispatch("mew:clip-open", {});
  await page.waitForTimeout(200);
  expect(await page.locator("#frame").getAttribute("src")).toBeNull();
});
