import { readFile } from "node:fs/promises";

import { expect, type Page, test } from "@playwright/test";

const DB_NAME = "mew-notebooks-local";

/** Draws a wavy horizontal stroke with the mouse, starting at canvas-relative (x, y). */
async function drawStroke(page: Page, x: number, y: number, length = 160, steps = 24) {
  const box = await page.getByTestId("notebook-canvas").boundingBox();
  if (!box) throw new Error("canvas not visible");
  await page.mouse.move(box.x + x, box.y + y);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(box.x + x + (length * i) / steps, box.y + y + Math.sin(i / 2) * 8);
  }
  await page.mouse.up();
}

async function storedStrokeCount(page: Page): Promise<number> {
  return page.evaluate(
    (name) =>
      new Promise<number>((resolve, reject) => {
        const open = indexedDB.open(name);
        open.onerror = () => reject(open.error ?? new Error("open failed"));
        open.onsuccess = () => {
          const db = open.result;
          const request = db.transaction("strokes").objectStore("strokes").count();
          request.onsuccess = () => {
            resolve(request.result);
            db.close();
          };
        };
      }),
    DB_NAME,
  );
}

/** Number of painted pixels on the committed-ink layer. */
async function inkedPixels(page: Page): Promise<number> {
  return page.getByTestId("ink-layer").evaluate((canvas: HTMLCanvasElement) => {
    const ctx = canvas.getContext("2d");
    if (!ctx) return 0;
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let count = 0;
    for (let i = 3; i < data.length; i += 4) if ((data[i] ?? 0) > 0) count++;
    return count;
  });
}

async function openNotebook(page: Page) {
  await page.goto("/notebook");
  await expect(page.getByTestId("notebook-canvas")).toBeVisible();
}

test.beforeEach(({ page }) => {
  page.on("console", (message) => {
    if (/Content.Security.Policy|Refused to/i.test(message.text())) {
      throw new Error(`CSP violation: ${message.text()}`);
    }
  });
});

test("strokes are drawn, saved locally and survive a reload", async ({ page }) => {
  await openNotebook(page);
  await drawStroke(page, 200, 200);
  await drawStroke(page, 200, 260);
  await drawStroke(page, 200, 320);

  await expect.poll(() => storedStrokeCount(page)).toBe(3);
  await expect.poll(() => inkedPixels(page)).toBeGreaterThan(500);

  await page.reload();
  await expect(page.getByTestId("notebook-canvas")).toBeVisible();
  await expect.poll(() => inkedPixels(page)).toBeGreaterThan(500);
  expect(await storedStrokeCount(page)).toBe(3);
});

test("eraser removes a stroke in one undoable step", async ({ page }) => {
  await openNotebook(page);
  await drawStroke(page, 200, 200);
  await drawStroke(page, 200, 300);
  await expect.poll(() => storedStrokeCount(page)).toBe(2);

  await page.keyboard.press("e");
  const box = await page.getByTestId("notebook-canvas").boundingBox();
  if (!box) throw new Error("canvas not visible");
  await page.mouse.move(box.x + 280, box.y + 170);
  await page.mouse.down();
  await page.mouse.move(box.x + 280, box.y + 230, { steps: 10 });
  await page.mouse.up();
  await expect.poll(() => storedStrokeCount(page)).toBe(1);

  await page.getByRole("button", { name: /^Undo/ }).click();
  await expect.poll(() => storedStrokeCount(page)).toBe(2);
  await page.getByRole("button", { name: /^Redo/ }).click();
  await expect.poll(() => storedStrokeCount(page)).toBe(1);
});

test("exports the current line as a PNG", async ({ page }) => {
  await openNotebook(page);
  await drawStroke(page, 150, 200, 120);
  await drawStroke(page, 290, 205, 100);
  await drawStroke(page, 150, 330, 140); // a second, later line: this is the "current" one

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Export current line as PNG" }).click(),
  ]);
  const file = await readFile(await download.path());

  expect(file.subarray(1, 4).toString("ascii")).toBe("PNG");
  const width = file.readUInt32BE(16);
  const height = file.readUInt32BE(20);
  expect(width).toBeGreaterThan(height); // one handwritten line: wide, short
  await expect(page.getByText(/Exported current line/)).toBeVisible();
});

test("zooms with the keyboard and resets the view", async ({ page }) => {
  await openNotebook(page);
  const zoomLabel = page.getByRole("button", { name: /^Zoom \d+%/ });

  await page.keyboard.press("=");
  await expect(zoomLabel).toHaveText("125%");
  await page.keyboard.press("0");
  await expect(zoomLabel).toHaveText("100%");
});

/** Left edge (bbox x) of every stored stroke, sorted. */
async function storedStrokeLefts(page: Page): Promise<number[]> {
  return page.evaluate(
    (name) =>
      new Promise<number[]>((resolve, reject) => {
        const open = indexedDB.open(name);
        open.onerror = () => reject(open.error ?? new Error("open failed"));
        open.onsuccess = () => {
          const request = open.result.transaction("strokes").objectStore("strokes").getAll();
          request.onsuccess = () => {
            const rows = request.result as { bbox: number[] }[];
            resolve(rows.map((r) => Math.round(r.bbox[0] ?? 0)).sort((a, b) => a - b));
            open.result.close();
          };
        };
      }),
    DB_NAME,
  );
}

test("lasso selects strokes, drags them, and deletes them — all undoable", async ({ page }) => {
  await openNotebook(page);
  await drawStroke(page, 200, 200, 100);
  await drawStroke(page, 600, 450, 100);
  await expect.poll(() => storedStrokeCount(page)).toBe(2);
  const [firstLeft, secondLeft] = await storedStrokeLefts(page);

  // Loop around the first stroke only.
  await page.keyboard.press("l");
  const box = await page.getByTestId("notebook-canvas").boundingBox();
  if (!box) throw new Error("canvas not visible");
  const at = (x: number, y: number) => page.mouse.move(box.x + x, box.y + y, { steps: 4 });
  await at(180, 170);
  await page.mouse.down();
  for (const [x, y] of [
    [320, 170],
    [320, 235],
    [180, 235],
    [180, 172],
  ] as const)
    await at(x, y);
  await page.mouse.up();

  // Drag the selection 150px right.
  await at(250, 200);
  await page.mouse.down();
  await at(400, 200);
  await page.mouse.up();
  await expect
    .poll(() => storedStrokeLefts(page))
    .toEqual([(firstLeft ?? 0) + 150, secondLeft ?? 0].sort((a, b) => a - b));

  await page.keyboard.press("Delete");
  await expect.poll(() => storedStrokeCount(page)).toBe(1);

  await page.keyboard.press("Control+z"); // restores the deleted stroke
  await expect.poll(() => storedStrokeCount(page)).toBe(2);
  await page.keyboard.press("Control+z"); // undoes the move
  await expect.poll(() => storedStrokeLefts(page)).toEqual([firstLeft, secondLeft]);
});

test("another tab showing the same page sees new strokes live", async ({ page }) => {
  await openNotebook(page);
  const otherTab = await page.context().newPage();
  await openNotebook(otherTab);
  expect(await inkedPixels(otherTab)).toBe(0);

  await drawStroke(page, 200, 200);

  await expect.poll(() => inkedPixels(otherTab)).toBeGreaterThan(100);
  await otherTab.close();
});

test("keeps drawing at 60 fps on a page with 1,500 existing strokes", async ({ page }) => {
  await openNotebook(page);
  await seedStrokes(page, 1500);
  await page.reload();
  await expect.poll(() => inkedPixels(page)).toBeGreaterThan(10_000);

  await page.evaluate(() => {
    const deltas: number[] = [];
    let last = performance.now();
    const tick = (now: number) => {
      deltas.push(now - last);
      last = now;
      (window as unknown as { __frames: number[] }).__frames = deltas;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await drawStroke(page, 100, 450, 900, 240);
  await page.mouse.move(10, 10);

  const frames = await page.evaluate(() =>
    (window as unknown as { __frames: number[] }).__frames.slice(2),
  );
  const sorted = [...frames].sort((a, b) => a - b);
  const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? Infinity;
  const fps = 1000 / (frames.reduce((sum, d) => sum + d, 0) / frames.length);
  console.log(`frames=${frames.length} avgFps=${fps.toFixed(1)} p95=${p95.toFixed(1)}ms`);

  expect(fps).toBeGreaterThan(55);
  expect(p95).toBeLessThan(25);
});

/** Writes strokes straight into IndexedDB, spread over the page, as the app would store them. */
async function seedStrokes(page: Page, count: number) {
  await page.evaluate(
    ({ name, count }) =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open(name);
        open.onerror = () => reject(open.error ?? new Error("open failed"));
        open.onsuccess = () => {
          const db = open.result;
          const pagesTx = db.transaction("pages").objectStore("pages").getAll();
          pagesTx.onsuccess = () => {
            const pageId = (pagesTx.result[0] as { id: string }).id;
            const tx = db.transaction("strokes", "readwrite");
            const store = tx.objectStore("strokes");
            for (let i = 0; i < count; i++) {
              const ox = (i % 40) * 30;
              const oy = Math.floor(i / 40) * 22;
              const points = Array.from({ length: 30 }, (_, k) => [
                ox + k,
                oy + Math.sin(k / 3) * 5,
                0.5,
                k * 8,
              ]);
              store.put({
                id: crypto.randomUUID(),
                pageId,
                author: "student",
                tool: "pen",
                points,
                color: "#1d1c1a",
                width: 2,
                bbox: [ox - 1, oy - 6, 31, 12],
                createdAt: i,
              });
            }
            tx.oncomplete = () => {
              db.close();
              resolve();
            };
          };
        };
      }),
    { name: DB_NAME, count },
  );
}
