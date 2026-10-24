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

// ─── Notes Check (N4) ────────────────────────────────────────────────────────────────────────

const LINE = "33333333-3333-4333-8333-333333333333";
const notesReply = {
  checkId: "44444444-4444-4444-8444-444444444444",
  related: true,
  topic: "Enzymes",
  speech: "Most of this matches your notes. There's one line I'd like you to look at again.",
  scopeLabel: "Compared with Biology, page 3",
  pages: [],
  latencyMs: 2300,
  findings: [
    {
      id: "55555555-5555-4555-8555-000000000001",
      type: "match",
      lineIds: [LINE],
      blockIds: ["b1"],
      noteQuote: "enzymes = biological catalysts",
      screenQuote: "Enzymes are biological catalysts",
      sourceConflict: false,
      confidence: 0.95,
      evidence: ["model"],
    },
    {
      id: "55555555-5555-4555-8555-000000000002",
      type: "difference",
      lineIds: [LINE],
      blockIds: ["b2"],
      noteQuote: "<img src=x onerror=alert(1)> used up",
      screenQuote: "not consumed",
      question: "Your notes say enzymes get used up. What does the slide say?",
      sourceConflict: false,
      confidence: 0.92,
      evidence: ["model", "second_opinion"],
    },
  ],
};

test("the Notes Check panel lists findings, differences first, as text only", async ({ page }) => {
  const shell = await openShellPage(page, "notes-panel.html");
  await shell.dispatch("mew:notes-panel-show", notesReply);

  await expect(page.getByText("Compared with Biology, page 3")).toBeVisible();
  const headings = page.locator("h2, summary");
  await expect(headings).toHaveText(["One line to look at again", "1 match"]);
  await expect(page.getByText("What does the slide say?")).toBeVisible();
  // Quotes from the screen and the notes are data: shown, never run.
  await expect(page.getByText(/<img src=x onerror=alert\(1\)>/)).toBeVisible();
  expect(await page.locator("img").count()).toBe(0);

  await page.getByRole("button", { name: "Show in notebook" }).first().click();
  await page.getByRole("button", { name: "Hide marks on screen" }).click();
  await page.keyboard.press("Escape");
  expect(await shell.calls()).toEqual([
    {
      cmd: "screen_notes_panel",
      args: { action: "open_line", findingId: "55555555-5555-4555-8555-000000000002" },
    },
    { cmd: "screen_notes_panel", args: { action: "hide_marks" } },
    { cmd: "screen_notes_panel", args: { action: "close" } },
  ]);
  expect(shell.violations).toEqual([]);
});

test("the Notes Check panel ignores a malformed reply", async ({ page }) => {
  const shell = await openShellPage(page, "notes-panel.html");
  await shell.dispatch("mew:notes-panel-show", { ...notesReply, findings: [{ type: "verdict" }] });
  await expect(page.locator("li")).toHaveCount(0);
});

test("the ink overlay draws Notes Check's ticks and amber circles, and the ticks fade", async ({
  page,
}) => {
  const shell = await openShellPage(page, "ink-overlay.html");
  await shell.dispatch("mew:ink-draw", {
    id: 7,
    seed: "check",
    actions: [
      { type: "focus_region", box: { left: 100, top: 40, right: 500, bottom: 200 }, kind: "text" },
      { type: "check_mark", box: { left: 100, top: 40, right: 400, bottom: 60 } },
      {
        type: "circle_region",
        box: { left: 100, top: 100, right: 400, bottom: 120 },
        tone: "question",
      },
    ],
    frame: [0, 0, 1280, 800],
    bounds: [0, 0, 1280, 800],
    obstacles: lines(128, 640),
    textHeight: 20,
    scale: 1,
    colors: { ink: "#8a7bf0", highlight: "#8a7bf055", question: "#d97706" },
    animate: false,
  });
  await expect.poll(async () => (await shell.calls()).length).toBe(1);
  type Drawn = { args: { ink: { strokes: { color: string }[] } } };
  const [drawn] = (await shell.calls()) as Drawn[];
  expect(drawn?.args.ink.strokes.map((s) => s.color)).toEqual(["#8a7bf0", "#d97706"]);

  // Violet (the tick) and amber (the question's circle) on the canvas: the tick goes after its
  // few seconds, the circle stays.
  const colours = () =>
    page.locator("canvas").evaluate((canvas: HTMLCanvasElement) => {
      const data = canvas.getContext("2d")?.getImageData(0, 0, canvas.width, canvas.height).data;
      let violet = 0;
      let amber = 0;
      for (let i = 0; data && i < data.length; i += 4) {
        const [r = 0, g = 0, b = 0, a = 0] = [data[i], data[i + 1], data[i + 2], data[i + 3]];
        if (a < 100) continue;
        if (b > 200 && r > 100) violet++;
        if (r > 180 && g > 80 && g < 160 && b < 80) amber++;
      }
      return { violet: violet > 20, amber: amber > 20 };
    });
  await expect.poll(colours).toEqual({ violet: true, amber: true });
  await expect.poll(colours, { timeout: 8_000 }).toEqual({ violet: false, amber: true });
  expect(shell.violations).toEqual([]);
});

// ─── The progress pill (coach mode, S4) ──────────────────────────────────────────────────────

const view = (change: Record<string, unknown> = {}) => ({
  title: "Pivot tables",
  progress: "Step 3 of ~7",
  state: "awaiting",
  ...change,
});

test("the progress pill shows the step and sends its buttons, one event at a time", async ({
  page,
}) => {
  const shell = await openShellPage(page, "coach-pill.html");
  await shell.dispatch("mew:coach-pill-show", view());

  await expect(page.getByText("Step 3 of ~7")).toBeVisible();
  await expect(page.getByText("Pivot tables")).toBeVisible();
  const buttons = page.locator("#coach-buttons button");
  await expect(buttons).toHaveText(["Done", "Hint", "Pause", "Stop"]);

  await page.getByRole("button", { name: "Done" }).click();
  // Until Rust sends the next view, nothing else can be pressed.
  for (const button of await buttons.all()) await expect(button).toBeDisabled();
  expect(await shell.calls()).toEqual([{ cmd: "screen_coach_pill", args: { action: "done" } }]);

  await shell.dispatch("mew:coach-pill-show", view({ state: "busy" }));
  await expect(page.getByText("Checking…")).toBeVisible();
  await expect(buttons).toHaveCount(0);

  await shell.dispatch("mew:coach-pill-show", view({ state: "confirming" }));
  await expect(page.getByText("Is it done?")).toBeVisible();
  await expect(buttons).toHaveText(["Yes", "No", "Stop"]);
  await page.getByRole("button", { name: "No" }).click();

  await shell.dispatch("mew:coach-pill-show", view({ state: "paused" }));
  await expect(buttons).toHaveText(["Resume", "Stop"]);
  await page.getByRole("button", { name: "Resume" }).click();
  expect((await shell.calls()).map((c) => (c.args as { action: string }).action)).toEqual([
    "done",
    "no",
    "resume",
  ]);
  expect(shell.violations).toEqual([]);
});

test("the progress pill ends with a tick and the summary", async ({ page }) => {
  const shell = await openShellPage(page, "coach-pill.html");
  await shell.dispatch(
    "mew:coach-pill-show",
    view({ state: "finished", progress: "", summary: "You did it with 1 hint." }),
  );
  await expect(page.getByText("You did it with 1 hint.")).toBeVisible();
  await expect(page.locator(".tick")).toBeVisible();
  await page.getByRole("button", { name: "Close" }).click();
  expect(await shell.calls()).toEqual([{ cmd: "screen_coach_pill", args: { action: "close" } }]);
});

test("the progress pill shows text as text and ignores a malformed view", async ({ page }) => {
  const shell = await openShellPage(page, "coach-pill.html");
  await shell.dispatch("mew:coach-pill-show", view({ title: "<img src=x onerror=alert(1)>" }));
  await expect(page.getByText("<img src=x onerror=alert(1)>")).toBeVisible();
  expect(await page.locator("img").count()).toBe(0);

  await shell.dispatch("mew:coach-pill-show", view({ state: "run_command", title: "Other" }));
  await expect(page.getByText("<img src=x onerror=alert(1)>")).toBeVisible();
  expect(shell.violations).toEqual([]);
});
