import { expect, type Page, test } from "./fixtures";

/**
 * Circle & Ask (S3.2): an explanation saved from the screen becomes an entry on the day's "From
 * screen" page: the picture, the student's marks, the tutor's ink in a group per step, and the
 * explanation under the picture, with Replay. A follow-up saved to the same entry is added to it.
 * The desktop app hands over only the clip's id; the clip routes are mocked, the rest is real.
 */

const DB_NAME = "mew-notebooks-local";
const CLIP_ID = "66666666-6666-4666-8666-666666666666";
const SESSION = "11111111-1111-4111-8111-111111111111";

test.beforeEach(({ page }) => {
  page.on("console", (message) => {
    if (/Content.Security.Policy|Refused to/i.test(message.text())) {
      throw new Error(`CSP violation: ${message.text()}`);
    }
  });
});

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

const stroke = (x: number, color: string) => ({
  tool: "pen",
  color,
  width: 3,
  points: [
    [x, 40, 0.5, 0],
    [x + 60, 80, 0.5, 40],
  ],
});

const TURN = {
  question: "Explain this",
  steps: ["This axis is velocity, not position.", "So a flat part means constant speed."],
  summary: "A flat line on a velocity–time graph means constant speed.",
  followUpQuestion: "What's the acceleration on the flat part?",
};

function entryClip(turns: unknown[], strokes: unknown[], strokeSteps: number[][]) {
  return {
    id: CLIP_ID,
    width: 400,
    height: 200,
    pixelRatio: 1,
    strokes,
    source: { app: "msedge.exe", capturedAt: "2026-10-24T10:00:00.000Z" },
    ocrText: "velocity (m/s)",
    notebookPageId: null,
    createdAt: "2026-10-24T10:00:01.000+00:00",
    entry: {
      sessionId: SESSION,
      studentStrokes: [stroke(150, "#3b5b8c")],
      turns,
      strokeSteps,
      conceptHints: ["Acceleration"],
    },
  };
}

async function stored(page: Page) {
  return page.evaluate(
    (name) =>
      new Promise<{ pages: { fromScreen?: number }[]; authors: string[] }>((resolve, reject) => {
        const open = indexedDB.open(name);
        open.onerror = () => reject(new Error("can't open the notebook"));
        open.onsuccess = () => {
          const tx = open.result.transaction(["pages", "strokes"], "readonly");
          const pages = tx.objectStore("pages").getAll();
          const strokes = tx.objectStore("strokes").getAll();
          tx.oncomplete = () =>
            resolve({
              pages: pages.result as { fromScreen?: number }[],
              authors: (strokes.result as { author: string }[]).map((s) => s.author),
            });
        };
      }),
    DB_NAME,
  );
}

test("an explanation saved from the screen lands on today's From screen page, with Replay", async ({
  page,
}) => {
  await page.goto("about:blank");
  const picture = await jpeg(page);
  let clip = entryClip(
    [TURN],
    [stroke(20, "#8a7bf0"), stroke(220, "#8a7bf0")],
    [
      [0, 0],
      [0, 1],
    ],
  );
  await page.route(`**/api/clips/${CLIP_ID}`, (route) =>
    route.request().method() === "PATCH"
      ? route.fulfill({ json: {} })
      : route.fulfill({ json: clip }),
  );
  await page.route(`**/api/clips/${CLIP_ID}/image`, (route) =>
    route.fulfill({ contentType: "image/jpeg", body: picture }),
  );

  await page.goto(`/notebook?entry=${CLIP_ID}`);

  const note = page.getByTestId("entry-note");
  await expect(note).toContainText("Explain this");
  await expect(note.getByRole("listitem")).toHaveText([
    "This axis is velocity, not position.",
    "So a flat part means constant speed.",
  ]);
  await expect(note).toContainText("To check: What's the acceleration on the flat part?");

  const first = await stored(page);
  expect(first.pages.filter((p) => p.fromScreen)).toHaveLength(1);
  // The student's mark is their own stroke; the tutor's ink is the tutor's.
  expect(first.authors.sort()).toEqual(["student", "tutor", "tutor"]);

  // Replay: the steps come back one at a time, the current one highlighted.
  await note.getByRole("button", { name: "Replay" }).click();
  await expect(note.getByRole("button", { name: "Stop replay" })).toBeVisible();
  await expect(note.locator("li[data-current]")).toHaveText("This axis is velocity, not position.");
  await expect(note.locator("li[data-current]")).toHaveText(
    "So a flat part means constant speed.",
    {
      timeout: 5_000,
    },
  );
  await expect(note.getByRole("button", { name: "Replay" })).toBeVisible({ timeout: 6_000 });

  // A follow-up in the same session is added to the same entry, on the same page.
  clip = entryClip(
    [TURN, { question: "And this?", steps: ["That's the steep part."], summary: "Steep." }],
    [stroke(20, "#8a7bf0"), stroke(220, "#8a7bf0"), stroke(300, "#8a7bf0")],
    [
      [0, 0],
      [0, 1],
      [1, 0],
    ],
  );
  await page.evaluate(
    (clipId) =>
      window.dispatchEvent(new CustomEvent("mew:open-entry", { detail: { clipId, open: false } })),
    CLIP_ID,
  );
  await expect(note).toContainText("And this?");
  const after = await stored(page);
  expect(after.pages.filter((p) => p.fromScreen)).toHaveLength(1);
  expect(after.authors.filter((a) => a === "tutor")).toHaveLength(3);
});
