import { expect, type Page, test } from "./fixtures";

/**
 * K9 acceptance (docs/NOTEBOOKS_K.md §7): I write `3x + 7 = 19`, then `3x = 26`. About a second
 * after the pen rests, `26` is circled with "sign?", with no voice. I fix it to `3x = 12` and the
 * circle turns into a ✓. The marks are on the page after a reload (they're the device's), reach
 * the server once made, aren't undone with my writing, and a line neb couldn't read gets a "?"
 * instead of a red circle. Also: tapping a mark (Not wrong, Why?), Hide-until-done with Alt+C,
 * and the toolbar's level.
 *
 * Recognition is mocked (each new line image gets the next reading); SymPy runs for real.
 */

const DB_NAME = "mew-notebooks-local";
/** neb's marks are all violet (U1), so they're told apart by kind. */
const RED = ["error", "missing"];
const GREEN = ["tick"];

type StoredStroke = {
  id: string;
  author: string;
  color: string;
  markKind?: string;
  bbox: [number, number, number, number];
};
type Reading = { text: string; latex: string | null; confidence?: number };

test.beforeEach(({ page }) => {
  page.on("console", (message) => {
    if (/Content.Security.Policy|Refused to/i.test(message.text())) {
      throw new Error(`CSP violation: ${message.text()}`);
    }
  });
});

/** Readings in the order line images are first seen; the gate ignores pauses. */
async function fakeServices(page: Page, readings: Reading[]) {
  const seen = new Map<string, number>();
  await page.route("**/api/recognize", (route) => {
    const image = (route.request().postDataJSON() as { image: string }).image;
    if (!seen.has(image)) seen.set(image, seen.size);
    const reading = readings[seen.get(image) ?? 0] ?? { text: "", latex: null };
    return route.fulfill({ json: { subject: "math", confidence: 0.95, ...reading } });
  });
  await page.route("**/api/mew", (route) =>
    route.fulfill({
      json: {
        output: { label: "ignore", confidence: 0.9, reason: "just writing" },
        source: "model",
        latencyMs: 30,
      },
    }),
  );
  const tutorCalls: { intent: string; lastUtterance: string; circled?: boolean }[] = [];
  await page.route("**/api/tutor", (route) => {
    tutorCalls.push(route.request().postDataJSON() as (typeof tutorCalls)[number]);
    const speech = "Look at what happens to the seven when it moves across.";
    return route.fulfill({
      contentType: "application/x-ndjson",
      body:
        [
          { type: "speech", text: speech, latencyMs: 100 },
          { type: "response", response: { speech, actions: [] }, latencyMs: 200 },
        ]
          .map((e) => JSON.stringify(e))
          .join("\n") + "\n",
    });
  });
  await page.route("**/api/tts", (route) =>
    route.fulfill({ contentType: "audio/pcm;rate=24000", body: Buffer.alloc(4800) }),
  );
  await page.route("**/api/stt/token", (route) => route.abort());
  const synced: { markKind: string; dismissedAs: string | null; resolvedAt: number | null }[] = [];
  await page.route("**/api/annotations", async (route) => {
    const body = route.request().postDataJSON() as { annotations: typeof synced };
    synced.push(...body.annotations);
    return route.fulfill({ json: { saved: body.annotations.length } });
  });
  return { tutorCalls, synced };
}

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

async function writeLine(page: Page, x: number, y: number, letters: number, size = 28) {
  const box = await page.getByTestId("notebook-canvas").boundingBox();
  if (!box) throw new Error("canvas not visible");
  for (let i = 0; i < letters; i++) {
    const left = box.x + x + i * size * 0.9;
    await page.mouse.move(left, box.y + y + size);
    await page.mouse.down();
    await page.mouse.move(left + size * 0.3, box.y + y, { steps: 4 });
    await page.mouse.move(left + size * 0.6, box.y + y + size, { steps: 4 });
    await page.mouse.up();
  }
}

function readStore<T>(page: Page, store: string): Promise<T[]> {
  return page.evaluate(
    ([name, storeName]) =>
      new Promise<T[]>((resolve, reject) => {
        const open = indexedDB.open(name);
        open.onerror = () => reject(open.error ?? new Error("open failed"));
        open.onsuccess = () => {
          const db = open.result;
          const request = db.transaction(storeName).objectStore(storeName).getAll();
          request.onsuccess = () => {
            resolve(request.result as T[]);
            db.close();
          };
        };
      }),
    [DB_NAME, store] as const,
  );
}

const strokes = (page: Page) => readStore<StoredStroke>(page, "strokes");
const marksIn = async (page: Page, kinds: string[]) =>
  (await strokes(page)).filter((s) => s.markKind !== undefined && kinds.includes(s.markKind));

test("K9: a wrong step is circled with a hint, silently; fixed, it turns into a tick", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const { tutorCalls, synced } = await fakeServices(page, [
    { text: "3x + 7 = 19", latex: "3x+7=19" },
    { text: "3x = 26", latex: "3x=26" },
    { text: "3x = 12", latex: "3x=12" },
  ]);
  await page.goto("/notebook");
  await expect(page.getByTestId("notebook-canvas")).toBeVisible();
  await warmChecker(page);

  await writeLine(page, 180, 200, 7);
  await page.waitForTimeout(2000); // line 1 is read (a first line: nothing to mark)
  await writeLine(page, 180, 260, 4);
  const penUp = Date.now();

  const mark = page.getByTestId("live-mark");
  await expect(mark).toHaveAttribute("aria-label", "Mark: sign?", { timeout: 10_000 });
  console.log(`[K9 e2e] marked ${Date.now() - penUp} ms after the pen stopped`);
  expect(await marksIn(page, RED)).not.toHaveLength(0);
  expect(tutorCalls).toHaveLength(0); // no voice unless asked
  await expect.poll(() => synced.some((a) => a.markKind === "error")).toBe(true);

  // Ctrl+Z takes back my last stroke, never the mark.
  const before = (await strokes(page)).filter((s) => s.author === "student").length;
  await page.keyboard.press("Control+KeyZ");
  await expect
    .poll(async () => (await strokes(page)).filter((s) => s.author === "student").length)
    .toBe(before - 1);
  expect(await marksIn(page, RED)).not.toHaveLength(0);
  await page.keyboard.press("Control+KeyY");

  // Fixed (the line rewritten: a new reading): the circle goes, a ✓ comes.
  await writeLine(page, 180 + 4 * 25, 260, 1);
  await expect(page.getByTestId("live-mark")).toHaveAttribute("data-kind", "tick", {
    timeout: 10_000,
  });
  await expect.poll(async () => (await marksIn(page, RED)).length).toBe(0);
  expect(await marksIn(page, GREEN)).toHaveLength(1);
  await expect
    .poll(() => synced.some((a) => a.markKind === "error" && a.resolvedAt !== null))
    .toBe(true);
  expect(tutorCalls).toHaveLength(0);

  // Reloaded (and the connection gone): the marks are the device's, still there.
  await page.reload();
  await expect(page.getByTestId("notebook-canvas")).toBeVisible();
  await page.context().setOffline(true);
  await expect(page.getByTestId("live-mark")).toHaveAttribute("data-kind", "tick");
  expect(await marksIn(page, GREEN)).toHaveLength(1);
  await page.context().setOffline(false);
});

test("K9: a line neb couldn't read gets a ?, never a red circle; tapping it asks", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await fakeServices(page, [
    { text: "3x + 7 = 19", latex: "3x+7=19" },
    { text: "3x = 2b", latex: "3x=2b", confidence: 0.5 },
  ]);
  await page.goto("/notebook");
  await warmChecker(page);
  await writeLine(page, 180, 200, 7);
  await page.waitForTimeout(2000);
  await writeLine(page, 180, 260, 4);

  const mark = page.getByTestId("live-mark");
  await expect(mark).toHaveAttribute("data-kind", "unsure", { timeout: 10_000 });
  expect(await marksIn(page, RED)).toHaveLength(0);
  await mark.click();
  await expect(page.getByTestId("mark-read-as")).toContainText("I read: 3x=2b — right?");
  // "No, it says 3x = 12": checked again as certain, and right.
  await page.getByRole("menuitem", { name: "No, it says…" }).click();
  await page.getByLabel("It says").fill("3x = 12");
  await page.getByRole("button", { name: "Check it" }).click();
  await expect(page.getByTestId("live-mark")).toHaveAttribute("data-kind", "tick", {
    timeout: 10_000,
  });
});

test("K9: tapping a mark: Not wrong takes it off and is kept as a correction; Why? asks", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const { tutorCalls, synced } = await fakeServices(page, [
    { text: "3x + 7 = 19", latex: "3x+7=19" },
    { text: "3x = 26", latex: "3x=26" },
  ]);
  await page.goto("/notebook");
  await warmChecker(page);
  await writeLine(page, 180, 200, 7);
  await page.waitForTimeout(2000);
  await writeLine(page, 180, 260, 4);
  const mark = page.getByTestId("live-mark");
  await expect(mark).toHaveAttribute("aria-label", "Mark: sign?", { timeout: 10_000 });

  // Why? → the tutor explains that line (the turn's circled line).
  await mark.click();
  await page.getByRole("menuitem", { name: "Why?" }).click();
  await expect.poll(() => tutorCalls.length).toBe(1);
  expect(tutorCalls[0]).toMatchObject({ intent: "answer_question", circled: true });

  // Not wrong → off the page, and sent as a correction.
  await mark.click();
  await page.getByRole("menuitem", { name: "Not wrong" }).click();
  await expect(page.getByTestId("live-mark")).toHaveCount(0);
  await expect.poll(async () => (await marksIn(page, RED)).length).toBe(0);
  await expect.poll(() => synced.some((a) => a.dismissedAs === "not_wrong")).toBe(true);
});

test("K9: Hide marks until I'm done keeps them back until Alt+C; Off marks nothing", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await fakeServices(page, [
    { text: "3x + 7 = 19", latex: "3x+7=19" },
    { text: "3x = 26", latex: "3x=26" },
    { text: "x = 4", latex: "x=4" },
  ]);
  await page.goto("/notebook");
  await warmChecker(page);
  await page.getByRole("button", { name: "View options" }).click();
  await page.getByTestId("marks-menu").click();
  await page.getByLabel("Hide marks until I'm done (Alt+C shows them)").check();
  await page.keyboard.press("Escape");

  await writeLine(page, 180, 200, 7);
  await page.waitForTimeout(2000);
  await writeLine(page, 180, 260, 4);
  // Worked out and stored, but not shown.
  await expect
    .poll(async () => (await marksIn(page, RED)).length, { timeout: 10_000 })
    .toBeGreaterThan(0);
  await expect(page.getByTestId("live-mark")).toHaveCount(0);
  await page.keyboard.press("Alt+KeyC");
  await expect(page.getByTestId("live-mark")).toHaveAttribute("aria-label", "Mark: sign?");

  // Off: the next line gets nothing.
  await page.getByRole("button", { name: "View options" }).click();
  await page.getByTestId("marks-menu").click();
  await page.getByLabel("Off").check();
  await page.keyboard.press("Escape");
  const marks = (await strokes(page)).filter((s) => s.markKind).length;
  await writeLine(page, 180, 330, 3);
  await page.waitForTimeout(3000);
  expect((await strokes(page)).filter((s) => s.markKind).length).toBe(marks);
});
