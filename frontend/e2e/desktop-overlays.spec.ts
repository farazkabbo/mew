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
        : name.endsWith(".woff2")
          ? "font/woff2"
          : name.endsWith(".svg")
            ? "image/svg+xml"
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
      // "Save this to Physics chapter 5" (K3, decision 126): the preview names the place.
      place: "Physics › Chapter 5",
      expiresInMs: 60_000,
    },
  });
  await shell.dispatch("mew:clip-open", {});

  await expect(page.locator("#heading")).toHaveText("Save to Physics › Chapter 5");
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
      place: null,
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

// ─── Circle & Ask (S3.2): the ink's steps, the pointer, the draw overlay and the card ────────

test("the ink overlay draws an explanation a step at a time, keeping the earlier steps", async ({
  page,
}) => {
  const shell = await openShellPage(page, "ink-overlay.html");
  const box = (l: number, t: number, r: number, b: number) => ({
    left: l,
    top: t,
    right: r,
    bottom: b,
  });
  const request = (step: number, actions: unknown[]) => ({
    id: 2 ** 40,
    seed: "session",
    actions,
    frame: [200, 200, 600, 300],
    bounds: [0, 0, 1280, 800],
    obstacles: [],
    scale: 1,
    colors: { ink: "#8a7bf0", highlight: "#8a7bf055" },
    animate: false,
    step,
  });
  await shell.dispatch(
    "mew:ink-draw",
    request(0, [{ type: "underline", box: box(100, 600, 900, 640) }]),
  );
  await shell.dispatch(
    "mew:ink-draw",
    request(1, [{ type: "circle_region", box: box(300, 200, 600, 400) }]),
  );
  await expect.poll(async () => (await shell.calls()).length).toBe(2);
  const steps = (await shell.calls()).map((c) => (c.args as { ink: { step?: number } }).ink.step);
  expect(steps).toEqual([0, 1]);

  // Step 0's underline is still on the canvas with step 1's circle (both violet).
  const violetRows = await page.locator("canvas").evaluate((canvas: HTMLCanvasElement) => {
    const data = canvas.getContext("2d")?.getImageData(0, 0, canvas.width, canvas.height).data;
    const rows = new Set<number>();
    for (let i = 0; data && i < data.length; i += 4) {
      if ((data[i + 3] ?? 0) > 100 && (data[i + 2] ?? 0) > 200)
        rows.add(Math.floor(i / 4 / canvas.width));
    }
    return [...rows];
  });
  // The underline sits at about y = 200 + 0.6 × 300; the circle higher up.
  expect(violetRows.some((y) => y > 370 && y < 400)).toBe(true);
  expect(violetRows.some((y) => y > 250 && y < 330)).toBe(true);
  expect(shell.violations).toEqual([]);
});

test("the pointer shows its look", async ({ page }) => {
  const shell = await openShellPage(page, "pointer.html");
  const pointer = page.locator("#pointer");
  await expect(pointer).toHaveAttribute("data-look", "idle");
  await shell.dispatch("mew:pointer-look", { look: "drawing" });
  await expect(pointer).toHaveAttribute("data-look", "drawing");
  await shell.dispatch("mew:pointer-look", { look: "<script>" });
  await expect(pointer).toHaveAttribute("data-look", "drawing");
  expect(shell.violations).toEqual([]);
});

test("the draw overlay sends a pen mark, shows the mouse's, and sends a keyboard mark", async ({
  page,
}) => {
  const shell = await openShellPage(page, "draw-overlay.html");
  await shell.dispatch("mew:draw-show", { marks: [], grey: false, drawing: true, mode: "draw" });
  // While drawing, the page isn't fully transparent: Windows would pass the mouse through.
  const tint = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(tint).toMatch(/^rgba\(255, 255, 255, 0\.00\d+\)$/);
  // The mouse is Rust's (it reads it while drawing): the page sends nothing for it.
  await page.mouse.move(100, 100);
  await page.mouse.down();
  await page.mouse.move(200, 160);
  await page.mouse.up();
  // A pen stroke is the page's own.
  await page.evaluate(() => {
    const pen = (type: string, x: number, y: number) =>
      window.dispatchEvent(
        new PointerEvent(type, { pointerType: "pen", clientX: x, clientY: y, pressure: 0.8 }),
      );
    pen("pointerdown", 100, 100);
    for (let i = 1; i <= 10; i++) pen("pointermove", 100 + i * 20, 100 + (i % 2) * 30);
    pen("pointerup", 300, 100);
  });
  await expect.poll(async () => (await shell.calls()).length).toBe(1);
  const [mark] = await shell.calls();
  expect(mark?.cmd).toBe("screen_draw_mark");
  const points = (mark?.args as { stroke: { points: number[][] } }).stroke.points;
  expect(points.length).toBeGreaterThan(5);
  expect(points[0]?.slice(0, 2)).toEqual([100, 100]);
  // The mouse stroke Rust reads shows as it's drawn, and bad input is ignored.
  await shell.dispatch("mew:draw-live", { start: true, points: [[10, 10]] });
  await shell.dispatch("mew:draw-live", { start: false, points: [[40, 40]] });
  await shell.dispatch("mew:draw-live", { start: false, points: [["x", 1]] });

  // "Select question on screen": Rust reads the drag and shows the box; the page asks for nothing.
  await shell.dispatch("mew:draw-show", { mode: "select" });
  await expect(page.getByText("Drag a box around your question.")).toBeVisible();
  await shell.dispatch("mew:draw-box", { from: [400, 300], to: [600, 360] });
  await page.mouse.move(400, 300);
  await page.mouse.down();
  await page.mouse.move(600, 360);
  await page.mouse.up();
  expect(await shell.calls()).toHaveLength(1);

  // Keyboard drawing: Tab to a block, Space marks it (a closed path around it).
  await shell.dispatch("mew:draw-show", {
    mode: "keyboard",
    blocks: [
      [50, 50, 200, 40],
      [50, 120, 300, 40],
    ],
    pointer: [60, 60],
  });
  await page.keyboard.press("Tab");
  await expect(page.getByText("Text block 1 of 2. Space to mark it.")).toBeVisible();
  await page.keyboard.press("Space");
  await expect.poll(async () => (await shell.calls()).length).toBe(2);
  const keyed = (await shell.calls())[1]?.args as { stroke: { points: number[][] } };
  expect(keyed.stroke.points[0]).toEqual([50, 50, 0.5]);
  expect(keyed.stroke.points.at(-1)).toEqual([50, 50, 0.5]);
  expect(shell.violations).toEqual([]);
});

test("the Circle & Ask card asks, plays steps with their controls, and counts the save down", async ({
  page,
}) => {
  const opened = await openShellPage(page, "circle-card.html");
  // The card also tells Rust its height as it changes ("fit", since the island): not an action.
  const shell = {
    ...opened,
    calls: async () =>
      (await opened.calls()).filter(
        (c) => (c.args as { action?: string } | undefined)?.action !== "fit",
      ),
  };
  await shell.dispatch("mew:card-show", { mode: "ask", silent: false });
  await expect(page.getByText("Or click the mic to ask out loud")).toBeVisible();
  // Ctrl+S: save the marks without an explanation (K2: two keys at most).
  await page.getByLabel("Your question").focus();
  await page.keyboard.press("Control+KeyS");
  await expect.poll(async () => (await shell.calls()).length).toBe(1);
  expect((await shell.calls())[0]).toEqual({
    cmd: "screen_circle_card",
    args: { action: "save_only" },
  });
  await shell.dispatch("mew:card-show", { mode: "ask", silent: false });
  await page.getByLabel("Your question").fill("why does this go up?");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await shell.calls()).length).toBe(2);
  expect((await shell.calls())[1]).toEqual({
    cmd: "screen_circle_card",
    args: { action: "ask", text: "why does this go up?" },
  });

  await shell.dispatch("mew:card-show", {
    mode: "explain",
    step: 1,
    total: 3,
    say: "This axis is velocity, not position.",
    paused: false,
  });
  await expect(page.getByText("Step 1 of 3")).toBeVisible();
  await expect(page.getByText("This axis is velocity, not position.")).toBeVisible();
  await page.getByRole("button", { name: "Next" }).click();
  expect((await shell.calls()).at(-1)).toEqual({
    cmd: "screen_circle_card",
    args: { action: "next" },
  });
  // ← repeats the step, → goes on, Space pauses (while the follow-up box is empty).
  await page.getByLabel("Your question").focus();
  for (const [key, action] of [
    ["ArrowLeft", "repeat"],
    ["ArrowRight", "next"],
    ["Space", "pause"],
  ] as const) {
    await shell.dispatch("mew:card-show", {
      mode: "explain",
      step: 2,
      total: 3,
      say: "Then it slows down.",
      paused: false,
    });
    await page.keyboard.press(key);
    await expect
      .poll(async () => (await shell.calls()).at(-1))
      .toEqual({ cmd: "screen_circle_card", args: { action } });
  }

  await shell.dispatch("mew:card-show", {
    mode: "toast",
    seconds: 5,
    canSave: true,
    followUp: "What's the acceleration there?",
  });
  await expect(page.getByText("✓ Saving to your notebook · From screen · 5")).toBeVisible();
  await expect(page.getByText("To check: What's the acceleration there?")).toBeVisible();
  await page.getByRole("button", { name: "Undo" }).click();
  expect((await shell.calls()).at(-1)).toEqual({
    cmd: "screen_circle_card",
    args: { action: "undo" },
  });

  // Text from the screen is text, never markup.
  await shell.dispatch("mew:card-show", {
    mode: "confirm",
    questions: ["<b>Find x</b>", "Find y"],
  });
  await page.getByRole("button", { name: "<b>Find x</b>" }).click();
  expect((await shell.calls()).at(-1)).toEqual({
    cmd: "screen_circle_card",
    args: { action: "confirm", text: "<b>Find x</b>" },
  });
  expect(await page.locator("b").count()).toBe(0);
  expect(shell.violations).toEqual([]);
});

test("the ink overlay draws a sketch card beside the marks: benzene, bond by bond (K5)", async ({
  page,
}) => {
  const shell = await openShellPage(page, "ink-overlay.html");
  const marked = { left: 250, top: 300, right: 450, bottom: 450 };
  await shell.dispatch("mew:ink-draw", {
    id: 9,
    seed: "turn-9",
    actions: [
      {
        type: "sketch",
        besideBox: marked,
        figure: {
          type: "draw_molecule",
          smiles: "c1ccccc1",
          atomLabels: [{ index: 0, text: "C–H" }],
        },
        pointTo: { x: 350, y: 375 },
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
  const ink = (call?.args as { ink: { strokes: { points: number[][] }[]; cards: number[][] } }).ink;
  // One card about 320 × 240, off the marked area (320–576 × 240–360 px here).
  expect(ink.cards).toHaveLength(1);
  const [x = 0, y = 0, w = 0, h = 0] = ink.cards[0] ?? [];
  expect([w, h]).toEqual([320, 240]);
  const overlaps = x < 576 && x + w > 320 && y < 360 && y + h > 240;
  expect(overlaps).toBe(false);
  // Six ring bonds, three inner double-bond strokes, the label and the arrow.
  expect(ink.strokes.length).toBeGreaterThan(12);
  if (process.env.SHOT_SKETCH) await page.screenshot({ path: process.env.SHOT_SKETCH });
  expect(shell.violations).toEqual([]);
});

test("the quiz card asks, takes a typed answer or a choice, and shows the grade (S6)", async ({
  page,
}) => {
  const shell = await openShellPage(page, "quiz-card.html");
  const question = {
    step: 1,
    total: 2,
    prompt: "Why is a thrown ball's path curved?",
    kind: "short",
    choices: [],
    phase: "asking",
    correct: null,
    said: null,
    last: false,
  };
  await shell.dispatch("mew:quiz-show", question);
  await expect(page.getByText("Quiz · question 1 of 2")).toBeVisible();
  await page.getByLabel("Your answer").fill("gravity pulls it down");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await shell.calls()).length).toBe(1);
  expect((await shell.calls())[0]).toEqual({
    cmd: "screen_quiz_card",
    args: { action: "answer", text: "gravity pulls it down" },
  });

  await shell.dispatch("mew:quiz-show", { ...question, phase: "checking" });
  await expect(page.getByText("checking…")).toBeVisible();
  await expect(page.getByRole("button", { name: "Skip" })).toBeDisabled();

  await shell.dispatch("mew:quiz-show", {
    ...question,
    phase: "answered",
    correct: true,
    said: "That's it.",
  });
  await expect(page.getByText("That's it.")).toBeVisible();
  await page.getByRole("button", { name: "Next ↵" }).click();
  expect((await shell.calls()).at(-1)).toEqual({
    cmd: "screen_quiz_card",
    args: { action: "next" },
  });

  // A multiple choice: one tap (or its number key) answers; its text is text, never markup.
  await shell.dispatch("mew:quiz-show", {
    ...question,
    step: 2,
    kind: "mcq",
    choices: ["<b>0</b>", "9.8 m/s²"],
    last: true,
  });
  await expect(page.getByLabel("Your answer")).toBeHidden();
  await page.getByRole("button", { name: "1. <b>0</b>" }).click();
  expect((await shell.calls()).at(-1)).toEqual({
    cmd: "screen_quiz_card",
    args: { action: "answer", text: "<b>0</b>" },
  });
  expect(await page.locator("b").count()).toBe(0);
  await page.keyboard.press("Escape");
  expect((await shell.calls()).at(-1)).toEqual({
    cmd: "screen_quiz_card",
    args: { action: "stop" },
  });
  // A malformed view changes nothing.
  await shell.dispatch("mew:quiz-show", { ...question, total: 9 });
  await expect(page.getByText("Quiz · question 2 of 2")).toBeVisible();
  expect(shell.violations).toEqual([]);
});

test("the status capsule and the held keys say what they mean, with no script (U8)", async ({
  page,
}) => {
  const capsule = await openShellPage(page, "capsule.html");
  const said = page.getByRole("status");
  await expect(said).toContainText("neb sees your screen only while");
  await expect(said).toContainText("frame is on");
  expect(capsule.violations).toEqual([]);
  const keys = await openShellPage(page, "keys-hint.html");
  await expect(page.getByRole("status")).toContainText("Ctrl");
  await expect(page.getByRole("status")).toContainText("held · circle anything");
  expect(keys.violations).toEqual([]);
});

test("the draw overlay draws the card's pointer line in neb's violet, and clears it (U8)", async ({
  page,
}) => {
  const shell = await openShellPage(page, "draw-overlay.html");
  await shell.dispatch("mew:draw-show", { marks: [], grey: false, drawing: false, mode: "draw" });
  const violetAt = (x: number, y: number) =>
    page.evaluate(
      ([px, py]) => {
        const canvas = document.querySelector("canvas");
        if (!canvas) return false;
        const ratio = window.devicePixelRatio;
        const d = canvas
          .getContext("2d")
          ?.getImageData(Math.round(px! * ratio), Math.round(py! * ratio), 1, 1).data;
        return !!d && d[3]! > 0 && d[2]! > d[1]! + 60;
      },
      [x, y],
    );
  await shell.dispatch("mew:draw-pointer", { from: [100, 100], to: [300, 100] });
  await expect.poll(() => violetAt(200, 100)).toBe(true);
  await shell.dispatch("mew:draw-pointer", null);
  await expect.poll(() => violetAt(200, 100)).toBe(false);
  // Anything but two points is ignored.
  await shell.dispatch("mew:draw-pointer", { from: "<x>", to: [1, 2] });
  await expect.poll(() => violetAt(200, 100)).toBe(false);
  expect(shell.violations).toEqual([]);
});
