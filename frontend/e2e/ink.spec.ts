import { expect, type Page, test } from "./fixtures";

/** M4 acceptance: the tutor writes a short equation next to my line, at my writing size,
 * without overlapping my work. The model and voice are mocked; everything else is real. */

const DB_NAME = "mew-notebooks-local";
const TUTOR_VIOLET = [0x8a, 0x7b, 0xf0] as const;

type StoredStroke = {
  id: string;
  author: "student" | "tutor";
  bbox: [number, number, number, number];
  width: number;
  groupId?: string;
};

test.beforeEach(({ page }) => {
  page.on("console", (message) => {
    if (/Content.Security.Policy|Refused to/i.test(message.text())) {
      throw new Error(`CSP violation: ${message.text()}`);
    }
  });
});

/** `seconds` of silence as 24 kHz s16le PCM. */
const silence = (seconds: number) => Buffer.alloc(Math.round(24_000 * seconds) * 2);

async function fakeTutor(page: Page, actions: unknown[], speech = "Here's the next step.") {
  // Only what the student says gets a response; writing pauses don't (one turn per test).
  await page.route("**/api/mew", (route) => {
    const spoken = (route.request().postDataJSON() as { trigger: string }).trigger === "utterance";
    return route.fulfill({
      json: {
        output: spoken
          ? { label: "complete_step", confidence: 0.95, reason: "asked for next step" }
          : { label: "ignore", confidence: 0.9, reason: "writing pause" },
        source: "model",
        latencyMs: 120,
      },
    });
  });
  await page.route("**/api/tutor", (route) =>
    route.fulfill({
      contentType: "application/x-ndjson",
      body:
        [
          { type: "speech", text: speech, latencyMs: 300 },
          { type: "response", response: { speech, actions }, latencyMs: 600 },
        ]
          .map((e) => JSON.stringify(e))
          .join("\n") + "\n",
    }),
  );
  await page.route("**/api/tts", (route) =>
    route.fulfill({ contentType: "audio/pcm;rate=24000", body: silence(1) }),
  );
  await page.route("**/api/recognize", (route) =>
    route.fulfill({ json: { text: "2x + 3 = 7", latex: "2x + 3 = 7", subject: "math" } }),
  );
}

/** Writes `count` zig-zag "letters", each its own stroke, `size` px tall, from canvas (x, y). */
async function writeLetters(page: Page, x: number, y: number, count: number, size: number) {
  const box = await page.getByTestId("notebook-canvas").boundingBox();
  if (!box) throw new Error("canvas not visible");
  for (let i = 0; i < count; i++) {
    const left = box.x + x + i * size * 0.9;
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

const tutorStrokes = async (page: Page) =>
  (await storedStrokes(page)).filter((s) => s.author === "tutor");

/** Pixels on the committed-ink layer painted in the tutor's violet. */
async function violetPixels(page: Page): Promise<number> {
  return page.getByTestId("ink-layer").evaluate((canvas: HTMLCanvasElement, rgb) => {
    const ctx = canvas.getContext("2d");
    if (!ctx) return 0;
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let count = 0;
    for (let i = 0; i < data.length; i += 4) {
      const close =
        Math.abs((data[i] ?? 0) - rgb[0]) < 24 &&
        Math.abs((data[i + 1] ?? 0) - rgb[1]) < 24 &&
        Math.abs((data[i + 2] ?? 0) - rgb[2]) < 24 &&
        (data[i + 3] ?? 0) > 200;
      if (close) count++;
    }
    return count;
  }, TUTOR_VIOLET);
}

async function ask(page: Page, text: string) {
  await page.getByRole("button", { name: "Debug panel" }).click();
  const input = page.getByRole("textbox", { name: "Simulated utterance" });
  await input.fill(text);
  await input.press("Enter");
}

const overlaps = (a: StoredStroke["bbox"], b: StoredStroke["bbox"]) =>
  a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3];

/** Typical letter height: median height of strokes that aren't flat (bars, minus signs). */
function letterHeight(strokes: StoredStroke[]): number {
  const heights = strokes
    .map((s) => [s.bbox[2] - s.width, s.bbox[3] - s.width] as const)
    .filter(([w, h]) => h > 0 && h >= 0.35 * w)
    .map(([, h]) => h)
    .sort((a, b) => a - b);
  return heights[Math.floor(heights.length / 2)] ?? 0;
}

test("writes an equation next to my line, at my size, without covering my work", async ({
  page,
}) => {
  await fakeTutor(page, [
    { type: "write_math", latex: "x = \\frac{7-3}{2}", anchor: { near: "active_line" } },
  ]);
  await page.goto("/notebook");
  await expect(page.getByTestId("notebook-canvas")).toBeVisible();
  await writeLetters(page, 160, 220, 8, 30);
  await ask(page, "what's next?");

  await expect
    .poll(async () => (await tutorStrokes(page)).length, { timeout: 15_000 })
    .toBeGreaterThan(5);
  const all = await storedStrokes(page);
  const student = all.filter((s) => s.author === "student");
  const tutor = all.filter((s) => s.author === "tutor");

  // One turn, one group.
  expect(new Set(tutor.map((s) => s.groupId)).size).toBe(1);
  // Never on top of the student's strokes.
  for (const t of tutor) for (const s of student) expect(overlaps(t.bbox, s.bbox)).toBe(false);
  // Next to the line: to its right, overlapping its vertical band.
  const lineRight = Math.max(...student.map((s) => s.bbox[0] + s.bbox[2]));
  const lineTop = Math.min(...student.map((s) => s.bbox[1]));
  const lineBottom = Math.max(...student.map((s) => s.bbox[1] + s.bbox[3]));
  const tutorLeft = Math.min(...tutor.map((s) => s.bbox[0]));
  const tutorTop = Math.min(...tutor.map((s) => s.bbox[1]));
  const tutorBottom = Math.max(...tutor.map((s) => s.bbox[1] + s.bbox[3]));
  expect(tutorLeft).toBeGreaterThan(lineRight);
  expect(tutorLeft - lineRight).toBeLessThan(200);
  expect(tutorTop).toBeLessThan(lineBottom);
  expect(tutorBottom).toBeGreaterThan(lineTop);
  // At the student's writing size.
  const ratio = letterHeight(tutor) / letterHeight(student);
  expect(ratio).toBeGreaterThan(0.6);
  expect(ratio).toBeLessThan(1.5);
  // It's visible, in the tutor's colour.
  expect(await violetPixels(page)).toBeGreaterThan(100);

  // The ink start was timed, and one undo removes the whole turn.
  await expect(page.getByTestId("tutor-turns").locator("li").first()).toContainText(/ink \d+/);
  // (Shortcuts are ignored while typing, so leave the debug text box first.)
  await page.getByRole("textbox", { name: "Simulated utterance" }).blur();
  await page.keyboard.press("Control+z");
  await expect.poll(async () => (await tutorStrokes(page)).length).toBe(0);
  expect((await storedStrokes(page)).length).toBe(student.length);
});

test("tutor ink survives a reload and can be hidden", async ({ page }) => {
  await fakeTutor(page, [
    { type: "write_text", text: "check the sign", anchor: { near: "below_active_line" } },
  ]);
  await page.goto("/notebook");
  await writeLetters(page, 160, 200, 6, 30);
  await ask(page, "is this right?");
  await expect
    .poll(async () => (await tutorStrokes(page)).length, { timeout: 15_000 })
    .toBeGreaterThan(5);
  const count = (await tutorStrokes(page)).length;

  await page.reload();
  await expect(page.getByTestId("notebook-canvas")).toBeVisible();
  await expect.poll(() => violetPixels(page)).toBeGreaterThan(100);
  expect((await tutorStrokes(page)).length).toBe(count);

  const toggle = page.getByRole("button", { name: "Show tutor ink (T)" });
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect.poll(() => violetPixels(page)).toBe(0);
  expect((await tutorStrokes(page)).length).toBe(count); // hidden, not deleted
  await page.keyboard.press("t");
  await expect.poll(() => violetPixels(page)).toBeGreaterThan(100);
});

test("pauses writing when I start writing, then finishes clear of my new strokes", async ({
  page,
}) => {
  const longSpeech =
    "Let's take this slowly: first subtract three from both sides, then divide by two, " +
    "and check the result by substituting it back into the original equation.";
  await fakeTutor(
    page,
    [
      { type: "write_math", latex: "2x = 7 - 3", anchor: { near: "below_active_line" } },
      { type: "write_math", latex: "x = 2", anchor: { near: "below_active_line" } },
    ],
    longSpeech,
  );
  await page.goto("/notebook");
  await writeLetters(page, 160, 200, 6, 30);
  await ask(page, "what's next?");

  // Wait until the tutor has started writing, then write underneath my line myself.
  await expect(page.getByTestId("tutor-turns").locator("li").first()).toContainText(/ink \d+/, {
    timeout: 10_000,
  });
  await writeLetters(page, 160, 260, 6, 30);
  expect((await tutorStrokes(page)).length).toBe(0); // paused, not committed yet

  await expect
    .poll(async () => (await tutorStrokes(page)).length, { timeout: 20_000 })
    .toBeGreaterThan(5);
  const all = await storedStrokes(page);
  const student = all.filter((s) => s.author === "student");
  for (const t of all.filter((s) => s.author === "tutor")) {
    for (const s of student) expect(overlaps(t.bbox, s.bbox)).toBe(false);
  }
});
