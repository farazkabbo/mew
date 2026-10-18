import { expect, type Page, test } from "@playwright/test";

/**
 * M5 acceptance: I write a wrong algebra step → it gets circled with a short hint; a correct
 * step gets a small check. Handwriting recognition is mocked (each line gets the LaTeX below,
 * in writing order); the maths check runs for real (Next → FastAPI → SymPy), as do the code
 * runner (Pyodide in a worker), Mew's pen-pause trigger and the ink.
 */

const DB_NAME = "mew-notebooks-local";
const RED = "#c8432b";
const GREEN = "#2f7d55";

type StoredStroke = {
  author: "student" | "tutor";
  color: string;
  bbox: [number, number, number, number];
};

test.beforeEach(({ page }) => {
  page.on("console", (message) => {
    if (/Content.Security.Policy|Refused to/i.test(message.text())) {
      throw new Error(`CSP violation: ${message.text()}`);
    }
  });
});

/**
 * Recognition answers in the order line images are first seen (lines must look different), and
 * a gate that ignores pauses.
 */
async function fakeServices(
  page: Page,
  lines: { text: string; latex: string | null; subject: string }[],
) {
  const seen = new Map<string, number>();
  await page.route("**/api/recognize", (route) => {
    const image = (route.request().postDataJSON() as { image: string }).image;
    if (!seen.has(image)) seen.set(image, seen.size);
    const answer = lines[seen.get(image) ?? 0] ?? { text: "", latex: null, subject: "other" };
    return route.fulfill({ json: answer });
  });
  await page.route("**/api/mew", (route) =>
    route.fulfill({
      json: {
        output: { label: "ignore", confidence: 0.9, reason: "just writing" },
        source: "model",
        latencyMs: 50,
      },
    }),
  );
  const tutorCalls: { intent: string; checks: unknown[] }[] = [];
  await page.route("**/api/tutor", (route) => {
    tutorCalls.push(route.request().postDataJSON() as (typeof tutorCalls)[number]);
    const speech = "Look again at what happens to the three when it moves across.";
    return route.fulfill({
      contentType: "application/x-ndjson",
      body:
        [
          { type: "speech", text: speech, latencyMs: 200 },
          { type: "response", response: { speech, actions: [] }, latencyMs: 400 },
        ]
          .map((e) => JSON.stringify(e))
          .join("\n") + "\n",
    });
  });
  await page.route("**/api/tts", (route) =>
    route.fulfill({ contentType: "audio/pcm;rate=24000", body: Buffer.alloc(9600) }),
  );
  return tutorCalls;
}

/** Waits until the maths checker answers (its first start imports SymPy, which is slow). */
async function warmChecker(page: Page) {
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const r = await fetch("/api/check/math", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ steps: ["x=1"] }),
          });
          return r.status;
        }),
      { timeout: 60_000, intervals: [1000] },
    )
    .toBe(200);
}

async function writeLine(page: Page, y: number, letters = 5, size = 28) {
  const box = await page.getByTestId("notebook-canvas").boundingBox();
  if (!box) throw new Error("canvas not visible");
  for (let i = 0; i < letters; i++) {
    const left = box.x + 180 + i * size * 0.9;
    await page.mouse.move(left, box.y + y + size);
    await page.mouse.down();
    await page.mouse.move(left + size * 0.3, box.y + y, { steps: 4 });
    await page.mouse.move(left + size * 0.6, box.y + y + size, { steps: 4 });
    await page.mouse.up();
  }
}

async function storedStrokes(page: Page): Promise<StoredStroke[]> {
  return page.evaluate(
    (name) =>
      new Promise<StoredStroke[]>((resolve, reject) => {
        const open = indexedDB.open(name);
        open.onerror = () => reject(open.error ?? new Error("open failed"));
        open.onsuccess = () => {
          const db = open.result;
          const request = db.transaction("strokes").objectStore("strokes").getAll();
          request.onsuccess = () => {
            resolve(request.result as StoredStroke[]);
            db.close();
          };
        };
      }),
    DB_NAME,
  );
}

const tutorInColor = async (page: Page, color: string) =>
  (await storedStrokes(page)).filter((s) => s.author === "tutor" && s.color === color);

/** The student's strokes in the band [top, bottom] (page units = CSS px at zoom 1). */
const studentBetween = async (page: Page, top: number, bottom: number) =>
  (await storedStrokes(page)).filter(
    (s) => s.author === "student" && s.bbox[1] >= top && s.bbox[1] + s.bbox[3] <= bottom,
  );

test("a wrong algebra step is circled with a short hint", async ({ page }) => {
  test.setTimeout(90_000); // may include the checker service's first start
  const tutorCalls = await fakeServices(page, [
    { text: "2x + 3 = 7", latex: "2x+3=7", subject: "math" },
    { text: "2x = 10", latex: "2x=10", subject: "math" },
  ]);
  await page.goto("/notebook");
  await expect(page.getByTestId("notebook-canvas")).toBeVisible();
  await warmChecker(page);

  await writeLine(page, 200);
  await page.waitForTimeout(3000); // pause: line 1 is recognised (and is just a first line)
  await writeLine(page, 250, 3); // a different shape, so it isn't mistaken for line 1

  // The pause after line 2 → SymPy says it doesn't follow → the tutor gets the verdict.
  await expect.poll(() => tutorCalls.length, { timeout: 15_000 }).toBe(1);
  expect(tutorCalls[0]?.intent).toBe("check_work");
  expect(tutorCalls[0]?.checks).toEqual([
    expect.objectContaining({
      checker: "math",
      verdict: "incorrect",
      target: true,
      detail: "x = 2 before, x = 5 after",
    }),
  ]);

  // Circled in red around line 2 (the model sent no marks: the verifier's mark is added),
  // with a short note beside it.
  await expect
    .poll(async () => (await tutorInColor(page, RED)).length, { timeout: 15_000 })
    .toBeGreaterThan(3);
  const red = await tutorInColor(page, RED);
  const loop = red.reduce((a, b) => (a.bbox[2] * a.bbox[3] > b.bbox[2] * b.bbox[3] ? a : b));
  for (const s of await studentBetween(page, 240, 290)) {
    expect(loop.bbox[0]).toBeLessThan(s.bbox[0]);
    expect(loop.bbox[0] + loop.bbox[2]).toBeGreaterThan(s.bbox[0] + s.bbox[2]);
  }
  await expect(page.getByTestId("tutor-caption")).toContainText("Look again");
});

test("a correct step gets a small tick, quietly", async ({ page }) => {
  const tutorCalls = await fakeServices(page, [
    { text: "2x + 3 = 7", latex: "2x+3=7", subject: "math" },
    { text: "2x = 4", latex: "2x=4", subject: "math" },
  ]);
  await page.goto("/notebook");
  await warmChecker(page);
  await writeLine(page, 200);
  await page.waitForTimeout(3000);
  await writeLine(page, 250, 3); // a different shape, so it isn't mistaken for line 1

  await expect
    .poll(async () => (await tutorInColor(page, GREEN)).length, { timeout: 15_000 })
    .toBe(1);
  const [tick] = await tutorInColor(page, GREEN);
  const line = await studentBetween(page, 240, 290);
  const lineRight = Math.max(...line.map((s) => s.bbox[0] + s.bbox[2]));
  expect(tick?.bbox[0]).toBeGreaterThan(lineRight); // beside the line, not on it
  expect(tick?.bbox[3]).toBeLessThan(60); // small
  expect(tutorCalls).toHaveLength(0); // no model call, no voice
  expect(await tutorInColor(page, RED)).toHaveLength(0);
});

test("code that crashes is caught by actually running it (Pyodide)", async ({ page }) => {
  test.setTimeout(90_000); // the first run downloads Python (~13 MB) into the worker
  const tutorCalls = await fakeServices(page, [
    { text: "print(totl + 1)", latex: null, subject: "programming" },
  ]);
  await page.goto("/notebook");
  await writeLine(page, 200);

  await expect.poll(() => tutorCalls.length, { timeout: 60_000 }).toBe(1);
  expect(tutorCalls[0]?.checks).toEqual([
    expect.objectContaining({
      checker: "code",
      verdict: "incorrect",
      detail: expect.stringContaining("NameError") as unknown,
    }),
  ]);
});
