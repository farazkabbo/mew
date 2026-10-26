import type { VerifiedSolution } from "@mew/shared";

import { expect, type Page, test } from "./fixtures";

/**
 * K6 acceptance (docs/NOTEBOOKS_K.md §6): I write 3x + 7 = 19 and say "just give me the answer".
 * The pointer writes each step with its reason, boxes x = 4, folds the solution and writes
 * "Your turn: 5x − 4 = 21". A wrong line gets circled with a hint; finishing correctly without
 * peeking is "You got it on your own" (its `independent` evidence is unit-tested in flow.test.ts:
 * logging needs a course). Also: holding Ctrl+Alt and circling a line asks about that line.
 *
 * The models are mocked (handwriting by the order line images are first seen, the gate, the
 * solution and the tutor's hint); SymPy runs for real, as do the ink, the pointer and the store.
 */

const DB_NAME = "mew-notebooks-local";
const RED = "#c8432b";

type Reading = { text: string; latex: string | null };
type StoredStroke = { author: string; color: string; bbox: [number, number, number, number] };
type StoredSolution = {
  folded: boolean;
  yourTurn: {
    problem: string;
    region: [number, number, number, number];
    status: string;
    peeked: boolean;
    hinted: boolean;
  } | null;
};

const SOLUTION: VerifiedSolution = {
  problem: { text: "3x + 7 = 19", latex: "3x + 7 = 19" },
  subject: "math",
  steps: [
    {
      work: "3x = 12",
      latex: "3x = 12",
      why: "Subtract 7 from both sides, to undo the plus 7.",
      figure: null,
    },
    { work: "x = 4", latex: "x = 4", why: "Divide both sides by 3, to get x alone.", figure: null },
  ],
  finalAnswer: { text: "x = 4", latex: "x = 4" },
  yourTurn: {
    problem: "5x − 4 = 21",
    latex: "5x - 4 = 21",
    answerKey: { text: "x = 5", latex: "x = 5" },
    skill: "two-step linear equations",
    conceptIds: [],
    program: null,
  },
  verification: { method: "sympy", passed: true },
  yourTurnVerified: true,
};

test.beforeEach(({ page }) => {
  page.on("console", (message) => {
    if (/Content.Security.Policy|Refused to/i.test(message.text())) {
      throw new Error(`CSP violation: ${message.text()}`);
    }
  });
});

const ndjson = (speech: string) =>
  [
    { type: "speech", text: speech, latencyMs: 100 },
    { type: "response", response: { speech, actions: [] }, latencyMs: 200 },
  ]
    .map((e) => JSON.stringify(e))
    .join("\n") + "\n";

/** Mocks every model route; returns the tutor's and the solution's requests. */
async function fakeServices(page: Page, readings: Reading[]) {
  const seen = new Map<string, number>();
  await page.route("**/api/recognize", (route) => {
    const image = (route.request().postDataJSON() as { image: string }).image;
    if (!seen.has(image)) seen.set(image, seen.size);
    const reading = readings[seen.get(image) ?? 0] ?? { text: "", latex: null };
    return route.fulfill({ json: { ...reading, subject: "math", confidence: 0.95 } });
  });
  await page.route("**/api/mew", (route) => {
    const { lastUtterance } = route.request().postDataJSON() as { lastUtterance: string };
    const answer = /give me the answer/i.test(lastUtterance);
    return route.fulfill({
      json: {
        output: answer
          ? { label: "show_full_solution", confidence: 0.95, reason: "asks for the answer" }
          : { label: "ignore", confidence: 0.9, reason: "just writing" },
        source: "model",
        latencyMs: 30,
      },
    });
  });
  const solutionCalls: unknown[] = [];
  await page.route("**/api/solution", (route) => {
    solutionCalls.push(route.request().postDataJSON());
    return route.fulfill({ json: { type: "solution", solution: SOLUTION } });
  });
  const tutorCalls: {
    intent: string;
    lastUtterance: string;
    circled: boolean;
    checks: { verdict: string; target: boolean }[];
    recognizedLines: { text: string }[];
  }[] = [];
  await page.route("**/api/tutor", (route) => {
    tutorCalls.push(route.request().postDataJSON() as (typeof tutorCalls)[number]);
    return route.fulfill({
      contentType: "application/x-ndjson",
      body: ndjson("Look at that line again."),
    });
  });
  await page.route("**/api/tts", (route) =>
    route.fulfill({ contentType: "audio/pcm;rate=24000", body: Buffer.alloc(4800) }),
  );
  await page.route("**/api/stt/token", (route) => route.abort());
  return { tutorCalls, solutionCalls };
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

/** A line of zigzag letters at page (x, y); different counts make different-looking lines. */
async function writeLine(page: Page, x: number, y: number, letters: number, size = 26) {
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

const solutions = (page: Page) => readStore<StoredSolution>(page, "solutions");
const strokes = (page: Page) => readStore<StoredStroke>(page, "strokes");

async function say(page: Page, text: string) {
  const input = page.getByRole("textbox", { name: "Simulated utterance" });
  await input.fill(text);
  await input.press("Enter");
}

test("just give me the answer: steps with reasons, folded, then a Your Turn checked line by line", async ({
  page,
}) => {
  test.setTimeout(120_000); // may include the checker service's first start
  const { tutorCalls, solutionCalls } = await fakeServices(page, [
    { text: "3x + 7 = 19", latex: "3x+7=19" },
    { text: "5x = 25", latex: "5x=25" },
    { text: "x = 6", latex: "x=6" },
    { text: "x = 5", latex: "x=5" },
  ]);
  await page.goto("/notebook");
  await expect(page.getByTestId("notebook-canvas")).toBeVisible();
  await warmChecker(page);
  await writeLine(page, 180, 160, 6);
  await page.waitForTimeout(2500); // the pen rests: the problem is read

  await page.getByRole("button", { name: "Debug panel", exact: true }).click();
  await say(page, "just give me the answer");
  await page.getByRole("button", { name: "Debug panel", exact: true }).click();

  // The pointer leaves the mascot and writes; the reasons are said.
  await expect(page.getByTestId("notebook-pointer")).toHaveAttribute("data-look", "writing");
  await expect(page.getByTestId("tutor-caption")).toContainText("to undo the plus 7");
  await expect(page.getByTestId("tutor-caption")).toContainText("to get x alone", {
    timeout: 15_000,
  });

  // Folded into a tab, with the Your Turn written and waiting.
  await expect(page.getByTestId("solution-tab")).toHaveText("Solution · tap to peek", {
    timeout: 20_000,
  });
  await expect(page.getByTestId("your-turn-panel")).toContainText("Your turn", {
    timeout: 20_000,
  });
  await expect(page.getByTestId("notebook-pointer")).toHaveAttribute("data-look", "resting");
  expect(solutionCalls).toHaveLength(1);
  const [record] = await solutions(page);
  expect(record?.folded).toBe(true);
  expect(record?.yourTurn?.problem).toBe("5x − 4 = 21");
  const region = record?.yourTurn?.region;
  if (!region) throw new Error("no Your Turn box");

  // In the box: a correct first line, then a wrong second line → circled, with a hint.
  const [left, top] = region;
  await writeLine(page, left + 20, top + 15, 4);
  await page.waitForTimeout(2500);
  await writeLine(page, left + 20, top + 70, 3);
  await expect.poll(() => tutorCalls.length, { timeout: 20_000 }).toBe(1);
  expect(tutorCalls[0]?.intent).toBe("check_work");
  expect(tutorCalls[0]?.checks.find((c) => c.target)?.verdict).toBe("incorrect");
  await expect
    .poll(
      async () =>
        (await strokes(page)).filter((s) => s.author === "tutor" && s.color === RED).length,
      { timeout: 15_000 },
    )
    .toBeGreaterThan(0);

  // Rub it out and write it right: done, on my own (no peek, no hint step).
  await page.keyboard.press("e");
  const box = await page.getByTestId("notebook-canvas").boundingBox();
  if (!box) throw new Error("canvas not visible");
  await page.mouse.move(box.x + left + 15, box.y + top + 82);
  await page.mouse.down();
  await page.mouse.move(box.x + left + 110, box.y + top + 82, { steps: 20 });
  await page.mouse.up();
  await page.keyboard.press("p");
  await writeLine(page, left + 20, top + 70, 5);
  await page
    .getByTestId("your-turn-panel")
    .getByRole("button", { name: /^Check/ })
    .click();

  await expect(page.getByTestId("your-turn-panel")).toContainText("You got it on your own.", {
    timeout: 20_000,
  });
  const [done] = await solutions(page);
  expect(done?.yourTurn).toMatchObject({ status: "done", peeked: false, hinted: false });

  // A peek opens the folded solution and closes it again.
  await page.getByTestId("solution-tab").click();
  await expect(page.getByTestId("solution-tab")).toHaveText("Solution · tap to fold");
  await page.getByTestId("solution-tab").click();
  await expect(page.getByTestId("solution-tab")).toHaveText("Solution · tap to peek");
});

test("holding Ctrl+Alt and circling a line asks about that line, writing nothing", async ({
  page,
}) => {
  const { tutorCalls } = await fakeServices(page, [
    { text: "F = ma", latex: "F = ma" },
    { text: "a = F / m", latex: "a = \\frac{F}{m}" },
  ]);
  await page.goto("/notebook");
  await expect(page.getByTestId("notebook-canvas")).toBeVisible();
  await writeLine(page, 180, 160, 4);
  await page.waitForTimeout(1500);
  await writeLine(page, 180, 300, 6);
  await page.waitForTimeout(1500);
  const before = (await strokes(page)).length;

  await page.keyboard.down("Control");
  await page.keyboard.down("Alt");
  await expect(page.getByTestId("hold-circle")).toBeVisible();
  // A loop round the first line only.
  const box = await page.getByTestId("notebook-canvas").boundingBox();
  if (!box) throw new Error("canvas not visible");
  const corners = [
    [160, 140],
    [300, 140],
    [300, 205],
    [160, 205],
    [160, 140],
  ] as const;
  await page.mouse.move(box.x + corners[0][0], box.y + corners[0][1]);
  await page.mouse.down();
  for (const [x, y] of corners.slice(1)) await page.mouse.move(box.x + x, box.y + y, { steps: 6 });
  await page.mouse.up();
  await page.keyboard.up("Alt");
  await page.keyboard.up("Control");

  await expect(page.getByTestId("hold-circle")).toBeHidden();
  await expect.poll(() => tutorCalls.length, { timeout: 10_000 }).toBe(1);
  expect(tutorCalls[0]).toMatchObject({
    intent: "answer_question",
    lastUtterance: "Explain this.",
    circled: true,
    recognizedLines: [{ text: "F = ma" }],
  });
  expect(await strokes(page)).toHaveLength(before); // the loop isn't ink
});

const CLIP_ID = "66666666-6666-4666-8666-666666666666";

/** A white JPEG made in the page (the entry's picture). */
async function jpeg(page: Page): Promise<Buffer> {
  const base64 = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 400;
    canvas.height = 200;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no canvas");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, 400, 200);
    return canvas.toDataURL("image/jpeg").split(",")[1] ?? "";
  });
  return Buffer.from(base64, "base64");
}

test("K7: just tell me the answer on screen waits in the notebook, folded, with a Your Turn", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await fakeServices(page, [
    { text: "5x = 25", latex: "5x=25" },
    { text: "x = 5", latex: "x=5" },
  ]);
  await page.goto("/notebook");
  await expect(page.getByTestId("notebook-canvas")).toBeVisible();
  await warmChecker(page);
  const picture = await jpeg(page);
  const clip = {
    id: CLIP_ID,
    width: 400,
    height: 200,
    pixelRatio: 1,
    strokes: [],
    source: { app: "msedge.exe", title: "Homework 3", capturedAt: "2026-10-24T10:00:00.000Z" },
    ocrText: "3x + 7 = 19",
    notebookPageId: null,
    createdAt: "2026-10-24T10:00:01.000+00:00",
    entry: {
      sessionId: "11111111-1111-4111-8111-111111111111",
      studentStrokes: [],
      turns: [
        {
          question: "3x + 7 = 19",
          steps: [SOLUTION.steps[0]?.why ?? "", "So the answer is x = 4."],
          summary: "Worked solution: x = 4.",
          followUpQuestion: "Your turn: 5x − 4 = 21",
        },
      ],
      strokeSteps: [],
      conceptHints: [],
      solution: {
        problem: SOLUTION.problem,
        steps: SOLUTION.steps.map(({ work, latex, why }) => ({ work, latex, why })),
        finalAnswer: SOLUTION.finalAnswer,
        yourTurn: {
          problem: SOLUTION.yourTurn.problem,
          latex: SOLUTION.yourTurn.latex,
          answerKey: SOLUTION.yourTurn.answerKey,
          skill: SOLUTION.yourTurn.skill,
        },
      },
    },
  };
  await page.route(`**/api/clips/${CLIP_ID}`, (route) =>
    route.request().method() === "PATCH"
      ? route.fulfill({ json: {} })
      : route.fulfill({ json: clip }),
  );
  await page.route(`**/api/clips/${CLIP_ID}/image`, (route) =>
    route.fulfill({ contentType: "image/jpeg", body: picture }),
  );

  await page.goto(`/notebook?entry=${CLIP_ID}`);
  await expect(page.getByTestId("entry-note")).toContainText("Worked solution: x = 4.");
  // Folded under the note, with the Your Turn waiting; announced politely.
  const tab = page.getByTestId("solution-tab");
  await expect(tab).toHaveText("Solution · tap to peek");
  const panel = page.getByTestId("your-turn-panel");
  await expect(panel).toContainText("Your turn");
  await expect(panel).toHaveAttribute("aria-live", "polite");

  const [record] = await solutions(page);
  const region = record?.yourTurn?.region;
  if (!region) throw new Error("no Your Turn box");
  expect(record?.yourTurn?.problem).toBe("5x − 4 = 21");

  // Keyboard and pen only: write the answer, Alt+C checks it.
  const [left, top] = region;
  await writeLine(page, left + 20, top + 15, 4);
  await page.waitForTimeout(2000);
  await writeLine(page, left + 20, top + 70, 3);
  await page.waitForTimeout(500);
  await page.keyboard.press("Alt+KeyC");
  await expect(panel).toContainText("You got it on your own.", { timeout: 20_000 });

  // The tab is a button the keyboard reaches: Enter peeks.
  await tab.focus();
  await page.keyboard.press("Enter");
  await expect(tab).toHaveText("Solution · tap to fold");
  // Written once (adopting again is a no-op: flow.test.ts).
  expect(await solutions(page)).toHaveLength(1);
});
