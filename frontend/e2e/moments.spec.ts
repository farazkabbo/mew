import { unsortedNodeId } from "@mew/shared";

import { expect, type Page, test } from "./fixtures";

/**
 * K8 acceptance (docs/NOTEBOOKS_K.md §4.6–4.7), the notebook's side: a saved moment is in its
 * notebook's Moments tab; Open source goes back to the video at that second; Replay plays the
 * explanation with its own stored voice; the next day a Quick check asks about it first, without
 * the moment, and a right answer with no peek or hint is sent as `independent`; "quiz me on what
 * I saved today" opens one; and a moment waiting in Unsorted is filed with "File these".
 *
 * Filing itself, the check's verification, FSRS, the daily cap and the evidence logging are
 * covered by the backend's and the web server's tests; here those routes are mocked.
 */

const DB_NAME = "mew-notebooks-local";
const CLIP_ID = "77777777-7777-4777-8777-777777777777";
const CHECK_ID = "88888888-8888-4888-8888-888888888888";
const VIDEO = "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=754";

const stroke = (x: number) => ({
  tool: "pen",
  color: "#8a7bf0",
  width: 3,
  points: [
    [x, 10, 0.5, 0],
    [x + 60, 30, 0.5, 40],
  ],
});

function clipView(destination: unknown = null) {
  return {
    id: CLIP_ID,
    width: 400,
    height: 200,
    pixelRatio: 1,
    strokes: [stroke(10), stroke(120)],
    source: {
      app: "msedge.exe",
      title: "Projectile motion lecture",
      url: VIDEO,
      timestampSec: 754,
      capturedAt: "2026-10-25T10:00:00.000Z",
    },
    ocrText: "Height against time for a thrown ball",
    notebookPageId: null,
    createdAt: "2026-10-25T10:00:01.000+00:00",
    destination,
    entry: {
      sessionId: "11111111-1111-4111-8111-111111111111",
      studentStrokes: [],
      turns: [
        {
          question: "Why is this curved?",
          steps: ["Gravity pulls the ball down the whole time.", "So its path bends."],
          summary: "Projectile motion under gravity is a parabola.",
        },
      ],
      strokeSteps: [
        [0, 0],
        [0, 1],
      ],
      conceptHints: ["projectile motion"],
    },
  };
}

/** A white JPEG made in the page (the moment's picture). */
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

function notebookIds(page: Page): Promise<{ id: string; title: string }[]> {
  return page.evaluate(
    (name) =>
      new Promise<{ id: string; title: string }[]>((resolve, reject) => {
        const open = indexedDB.open(name);
        open.onerror = () => reject(open.error ?? new Error("open failed"));
        open.onsuccess = () => {
          const db = open.result;
          const request = db.transaction("notebooks").objectStore("notebooks").getAll();
          request.onsuccess = () => {
            resolve(request.result as { id: string; title: string }[]);
            db.close();
          };
        };
      }),
    DB_NAME,
  );
}

/** Every model and speech route, mocked; Mew hears "quiz me…" as a question for Neb. */
async function quietServices(page: Page) {
  await page.route("**/api/mew", (route) =>
    route.fulfill({
      json: {
        output: { label: "answer_question", confidence: 0.95, reason: "talks to neb" },
        source: "model",
        latencyMs: 30,
      },
    }),
  );
  await page.route("**/api/tts", (route) =>
    route.fulfill({ contentType: "audio/pcm;rate=24000", body: Buffer.alloc(4800) }),
  );
  await page.route("**/api/stt/token", (route) => route.abort());
  await page.route("**/api/tutor", (route) =>
    route.fulfill({ status: 500, json: { error: "the tutor isn't part of this test" } }),
  );
}

test("K8: a moment's Moments tab, Open source, Replay in its own voice and a Quick check", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await quietServices(page);
  await page.goto("/notebook");
  await expect(page.getByTestId("notebook-canvas")).toBeVisible();
  const picture = await jpeg(page);
  const [notebook] = await notebookIds(page);
  if (!notebook) throw new Error("no notebook");

  await page.route(`**/api/clips/${CLIP_ID}`, (route) =>
    route.request().method() === "PATCH"
      ? route.fulfill({ json: {} })
      : route.fulfill({ json: clipView() }),
  );
  await page.route(`**/api/clips/${CLIP_ID}/image`, (route) =>
    route.fulfill({ contentType: "image/jpeg", body: picture }),
  );
  const voice: string[] = [];
  await page.route(`**/api/moments/${CLIP_ID}/audio/**`, (route) => {
    voice.push(new URL(route.request().url()).pathname.split("/audio/")[1] ?? "");
    // A short beep's worth of 16-bit PCM (silence is enough to play).
    return route.fulfill({ contentType: "audio/L16", body: Buffer.alloc(9600) });
  });
  const day = 86_400_000;
  const check = {
    id: CHECK_ID,
    clipId: CLIP_ID,
    nodeId: notebook.id,
    prompt: "Why does the path of a thrown ball curve?",
    kind: "short",
    choices: [],
    conceptHints: ["projectile motion"],
    isNew: true,
    dueAt: new Date(Date.now() - 60_000).toISOString(),
    createdAt: new Date(Date.now() - day).toISOString(),
  };
  await page.route("**/api/moments/checks", (route) =>
    route.fulfill({ json: { checks: [check] } }),
  );
  const answers: unknown[] = [];
  await page.route(`**/api/moments/checks/${CHECK_ID}/answer`, (route) => {
    answers.push(route.request().postDataJSON());
    return route.fulfill({
      json: {
        correct: true,
        evidence: "independent",
        answerKey: "Gravity accelerates it downward while it moves sideways.",
        feedback: "That's it.",
        nextDue: new Date(Date.now() + 3 * day).toISOString(),
      },
    });
  });

  // The moment arrives (saved in the desktop app) and lands on the notebook's page.
  await page.goto(`/notebook?entry=${CLIP_ID}`);
  await expect(page.getByTestId("entry-note")).toContainText("Why is this curved?");

  // The breadcrumb opens the notebook's home: its Moments tab, and a check due.
  await page.getByTestId("breadcrumb").getByRole("button", { name: notebook.title }).click();
  await expect(page.getByTestId("node-home")).toBeVisible();
  await expect(page.getByTestId("quick-check-card")).toContainText("1 check due");
  await page.getByRole("tab", { name: /Moments/ }).click();
  const row = page.getByTestId("moment-row");
  await expect(row).toContainText("Why is this curved?");
  // Grouped by source (U28): the source is the group's heading.
  await expect(page.getByTestId("moment-group")).toContainText("Projectile motion lecture");
  // Open source: the video at that exact second.
  await expect(row.getByRole("link", { name: /Open source/ })).toHaveAttribute("href", VIDEO);
  await page.getByPlaceholder("Search what you asked or saved").fill("mitosis");
  await expect(page.getByTestId("moment-row")).toHaveCount(0);
  await page.getByPlaceholder("Search what you asked or saved").fill("parabola");
  await expect(page.getByTestId("moment-row")).toHaveCount(1);

  // Opening it shows it on its page; Replay says each step in its stored voice.
  await page.getByTestId("moment-row").getByRole("button").first().click();
  await expect(page.getByTestId("entry-note")).toBeVisible();
  await page.getByTestId("entry-note").getByRole("button", { name: "Replay" }).click();
  await expect.poll(() => voice, { timeout: 15_000 }).toEqual(["0/0", "0/1"]);
  await expect(page.getByTestId("entry-note").getByRole("button", { name: "Replay" })).toBeVisible({
    timeout: 15_000,
  });

  // The Quick check: the question first, without the moment.
  await page.getByTestId("breadcrumb").getByRole("button", { name: notebook.title }).click();
  await page.getByTestId("quick-check-card").getByRole("button", { name: "Quick check" }).click();
  const quick = page.getByTestId("quick-check");
  await expect(quick.getByTestId("quick-check-question")).toHaveText(check.prompt);
  await expect(quick.getByTestId("quick-check-moment")).toHaveCount(0);
  await quick.getByTestId("quick-check-answer").fill("Gravity pulls it down as it moves along.");
  await page.keyboard.press("Enter");
  await expect(quick.getByTestId("quick-check-result")).toContainText("That's it.");
  // No peek, no hint: counted as independent. Then the moment it came from.
  expect(answers).toEqual([
    { answer: "Gravity pulls it down as it moves along.", peeked: false, hinted: false },
  ]);
  await expect(quick.getByTestId("quick-check-moment")).toContainText("From your moment on");
  await expect(quick.getByTestId("quick-check-moment").getByRole("link")).toHaveAttribute(
    "href",
    VIDEO,
  );
  await quick.getByRole("button", { name: "Finish" }).click();
  await expect(quick.getByTestId("quick-check-done")).toContainText("1 of 1 done");
  await quick.getByRole("button", { name: "Close", exact: true }).click();

  // "Quiz me on what I saved today" opens one (by voice: the debug panel stands in for Mew).
  await page.getByRole("button", { name: "Debug panel", exact: true }).click();
  const input = page.getByRole("textbox", { name: "Simulated utterance" });
  await input.fill("quiz me on what I saved today");
  await input.press("Enter");
  await expect(page.getByTestId("quick-check")).toBeVisible({ timeout: 10_000 });
});

/** A moment saved to Unsorted (with filing's suggestion mocked), Unsorted's home open. */
async function waitingInUnsorted(page: Page) {
  await quietServices(page);
  await page.goto("/notebook");
  await expect(page.getByTestId("notebook-canvas")).toBeVisible();
  const picture = await jpeg(page);
  const [notebook] = await notebookIds(page);
  if (!notebook) throw new Error("no notebook");
  const unsorted = unsortedNodeId("local");

  await page.route(`**/api/clips/${CLIP_ID}`, (route) =>
    route.request().method() === "PATCH"
      ? route.fulfill({ json: {} })
      : route.fulfill({
          json: clipView({ nodeId: unsorted, page: { kind: "from_screen" }, path: ["Unsorted"] }),
        }),
  );
  await page.route(`**/api/clips/${CLIP_ID}/image`, (route) =>
    route.fulfill({ contentType: "image/jpeg", body: picture }),
  );
  await page.route("**/api/moments/checks", (route) => route.fulfill({ json: { checks: [] } }));
  await page.route("**/api/moments/suggestions", (route) =>
    route.fulfill({
      json: {
        suggestions: [
          {
            clipId: CLIP_ID,
            nodeId: notebook.id,
            path: [notebook.title],
            method: "content_match",
            matched: "projectile motion",
          },
        ],
      },
    }),
  );
  const moves: unknown[] = [];
  await page.route(`**/api/moments/${CLIP_ID}/move`, (route) => {
    moves.push(route.request().postDataJSON());
    return route.fulfill({ status: 204, body: "" });
  });

  await page.goto(`/notebook?entry=${CLIP_ID}`);
  // Saved where filing put it: the Unsorted notebook, made on this device, with a count.
  const row = page.getByRole("treeitem", { name: "Unsorted" });
  await expect(row).toBeVisible();
  await expect(row.getByTestId("tree-row-count")).toHaveText("1");

  await row.click();
  return { notebook, row, moves };
}

test("K8: a moment waiting in Unsorted is filed with File these, and the server follows", async ({
  page,
}) => {
  const { notebook, row, moves } = await waitingInUnsorted(page);
  const tidy = page.getByTestId("file-these");
  await expect(tidy.getByTestId("file-these-row")).toContainText(
    `${notebook.title} · matched “projectile motion”`,
  );
  await tidy.getByRole("button", { name: "File", exact: true }).click();
  await expect(tidy.getByTestId("file-these-row")).toContainText(`Filed in ${notebook.title}`);
  expect(moves).toEqual([{ nodeId: notebook.id }]);
  await expect(row.getByTestId("tree-row-count")).toHaveCount(0);

  // It's in its new notebook's moments now.
  // A notebook clicked in the sidebar opens its home.
  await page.getByRole("treeitem", { name: notebook.title }).click();
  await expect(page.getByTestId("node-home")).toBeVisible();
  await page.getByRole("tab", { name: /Moments/ }).click();
  await expect(page.getByTestId("moment-row")).toContainText("Why is this curved?");
});

test("U9: the picker suggests a place and why, and makes a chapter to file it in", async ({
  page,
}) => {
  const { notebook, moves } = await waitingInUnsorted(page);
  await page.getByTestId("file-these").getByRole("button", { name: "Choose…" }).click();
  const picker = page.getByRole("dialog", { name: "File this moment in…" });
  await expect(picker.getByTestId("picker-suggestion")).toContainText(
    "suggested: matched “projectile motion”",
  );
  // "+ New chapter here" on the notebook's row: named, made, and the moment filed in it.
  await picker.getByRole("button", { name: notebook.title, exact: true }).hover();
  await picker.getByRole("button", { name: "New chapter here" }).click();
  await picker.getByRole("textbox", { name: "Name the new chapter" }).fill("Projectile motion");
  await picker.getByRole("button", { name: "Make it" }).click();
  await expect(picker).toBeHidden();
  await expect.poll(() => moves.length).toBe(1);
  const chapter = (await notebookIds(page)).find((n) => n.title === "Projectile motion");
  expect(chapter).toBeDefined();
  expect(moves[0]).toEqual({ nodeId: chapter?.id });
});
