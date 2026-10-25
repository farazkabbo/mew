import { expect, type Page, test } from "./fixtures";

/**
 * M6 acceptance: "draw a mind map of the causes of WW1" and "graph y = sin x" both appear as
 * hand-drawn ink. The model's replies are mocked (as the real model would answer); layout (ELK),
 * hand-drawn shapes (roughjs), the glyph font and the ink animation are real.
 */

const DB_NAME = "mew-notebooks-local";

type StoredStroke = {
  author: "student" | "tutor";
  bbox: [number, number, number, number];
  points: number[][];
};

test.beforeEach(({ page }) => {
  page.on("console", (message) => {
    if (/Content.Security.Policy|Refused to/i.test(message.text())) {
      throw new Error(`CSP violation: ${message.text()}`);
    }
  });
});

async function tutorReplies(page: Page, speech: string, actions: unknown[]) {
  await page.route("**/api/mew", (route) =>
    route.fulfill({
      json: {
        output: { label: "draw_visual", confidence: 0.95, reason: "asked for a drawing" },
        source: "model",
        latencyMs: 80,
      },
    }),
  );
  await page.route("**/api/tutor", (route) =>
    route.fulfill({
      contentType: "application/x-ndjson",
      body:
        [
          { type: "speech", text: speech, latencyMs: 200 },
          { type: "response", response: { speech, actions }, latencyMs: 500 },
        ]
          .map((e) => JSON.stringify(e))
          .join("\n") + "\n",
    }),
  );
  await page.route("**/api/tts", (route) =>
    route.fulfill({ contentType: "audio/pcm;rate=24000", body: Buffer.alloc(9600) }),
  );
}

async function ask(page: Page, text: string) {
  await page.getByRole("button", { name: "Debug panel" }).click();
  const input = page.getByRole("textbox", { name: "Simulated utterance" });
  await input.fill(text);
  await input.press("Enter");
}

async function tutorStrokes(page: Page): Promise<StoredStroke[]> {
  return page.evaluate(
    (name) =>
      new Promise<StoredStroke[]>((resolve, reject) => {
        const open = indexedDB.open(name);
        open.onerror = () => reject(open.error ?? new Error("open failed"));
        open.onsuccess = () => {
          const db = open.result;
          const request = db.transaction("strokes").objectStore("strokes").getAll();
          request.onsuccess = () => {
            resolve((request.result as StoredStroke[]).filter((s) => s.author === "tutor"));
            db.close();
          };
        };
      }),
    DB_NAME,
  );
}

const extent = (strokes: StoredStroke[]) => {
  const x0 = Math.min(...strokes.map((s) => s.bbox[0]));
  const y0 = Math.min(...strokes.map((s) => s.bbox[1]));
  const x1 = Math.max(...strokes.map((s) => s.bbox[0] + s.bbox[2]));
  const y1 = Math.max(...strokes.map((s) => s.bbox[1] + s.bbox[3]));
  return { width: x1 - x0, height: y1 - y0 };
};

test("draws a mind map of the causes of WW1 in ink", async ({ page }) => {
  await tutorReplies(page, "Here are the main causes, around the war itself.", [
    {
      type: "draw_graph",
      kind: "mindmap",
      nodes: [
        { id: "ww1", label: "WW1" },
        { id: "mil", label: "Militarism" },
        { id: "all", label: "Alliances" },
        { id: "imp", label: "Imperialism" },
        { id: "nat", label: "Nationalism" },
        { id: "fra", label: "Franz Ferdinand" },
      ],
      edges: ["mil", "all", "imp", "nat", "fra"].map((to) => ({ from: "ww1", to })),
      anchor: { near: "free_space" },
    },
  ]);
  await page.goto("/notebook");
  await expect(page.getByTestId("notebook-canvas")).toBeVisible();
  await ask(page, "draw a mind map of the causes of WW1");

  await expect
    .poll(async () => (await tutorStrokes(page)).length, { timeout: 20_000 })
    .toBeGreaterThan(40);
  const ink = await tutorStrokes(page);
  // Six labelled nodes around a centre: a broad, roughly square diagram, not a line of text.
  const { width, height } = extent(ink);
  expect(width).toBeGreaterThan(250);
  expect(height).toBeGreaterThan(150);
  // Drawn by hand: outlines are pen strokes with many points, not rectangles of four corners.
  expect(Math.max(...ink.map((s) => s.points.length))).toBeGreaterThan(40);
  if (process.env.SHOT_MAP) await page.screenshot({ path: process.env.SHOT_MAP });
  await expect(page.getByTestId("tutor-turns").locator("li").first()).toContainText(
    /1 board action · \d+ ink strokes/,
  );
});

test("graphs y = sin x in ink", async ({ page }) => {
  await tutorReplies(page, "Here's sine: it repeats every two pi.", [
    {
      type: "draw_plot",
      expressions: ["sin(x)"],
      xRange: [-6.3, 6.3],
      anchor: { near: "free_space" },
    },
  ]);
  await page.goto("/notebook");
  await expect(page.getByTestId("notebook-canvas")).toBeVisible();
  await ask(page, "graph y = sin x");

  await expect
    .poll(async () => (await tutorStrokes(page)).length, { timeout: 20_000 })
    .toBeGreaterThan(10);
  const ink = await tutorStrokes(page);
  // The curve: one long stroke that rises and falls (two full waves across the range).
  const curve = ink.reduce((a, b) => (a.points.length > b.points.length ? a : b));
  const ys = curve.points.map((p) => p[1] ?? 0);
  // Count direction changes, carrying the last clear direction across the flat tops.
  let turns = 0;
  let direction = 0;
  for (let i = 1; i < ys.length; i++) {
    const step = (ys[i] ?? 0) - (ys[i - 1] ?? 0);
    if (Math.abs(step) < 0.5) continue;
    if (direction !== 0 && Math.sign(step) !== direction) turns++;
    direction = Math.sign(step);
  }
  expect(turns).toBeGreaterThanOrEqual(3); // sin x over [−2π, 2π] has four turning points
  expect(curve.bbox[2]).toBeGreaterThan(1.5 * curve.bbox[3]); // wider than tall, like the plot
  if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT });
});
