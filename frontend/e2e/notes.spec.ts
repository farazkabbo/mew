import type { NotePageSync, NotePageSyncResult } from "@mew/shared";

import { expect, type Page, test } from "./fixtures";

/**
 * Notes Check N1 acceptance (docs/SCREEN_COACH_NOTES_CHECK.md §12): every line of a notebook
 * page reaches the server with its text, a box and an embedding, and an edited line is updated
 * within 3 s of the pen pause. Recognition is mocked (no model keys in e2e); the API service is
 * real (local mode, lexical embeddings).
 */

type Sync = { body: NotePageSync; result: NotePageSyncResult; at: number };

/** Answers recognition with the next text for each line image it hasn't seen before. */
async function fakeRecognition(page: Page, texts: string[]) {
  const seen = new Map<string, string>();
  const answer = (image: string) => {
    if (!seen.has(image)) seen.set(image, texts[seen.size] ?? "");
    return { text: seen.get(image) ?? "", latex: null, subject: "biology", confidence: 0.92 };
  };
  await page.route("**/api/recognize", (route) =>
    route.fulfill({ json: answer((route.request().postDataJSON() as { image: string }).image) }),
  );
  await page.route("**/api/recognize/batch", (route) =>
    route.fulfill({
      json: { lines: (route.request().postDataJSON() as { images: string[] }).images.map(answer) },
    }),
  );
  // The gate stays quiet: these tests are about the notes, not the tutor.
  await page.route("**/api/mew", (route) =>
    route.fulfill({
      json: {
        output: { label: "ignore", confidence: 0.9, reason: "writing" },
        source: "model",
        latencyMs: 20,
      },
    }),
  );
}

/**
 * Every sync the page makes, passed on to the real API service, with its answer and when it
 * arrived.
 */
async function recordSyncs(page: Page): Promise<Sync[]> {
  const syncs: Sync[] = [];
  await page.route("**/api/notes/pages/*/lines", async (route) => {
    const response = await route.fetch();
    const result = (await response.json()) as NotePageSyncResult;
    syncs.push({ body: route.request().postDataJSON() as NotePageSync, result, at: Date.now() });
    await route.fulfill({ response });
  });
  return syncs;
}

/** Writes `letters` zig-zag letters starting `fromLetter` letters in, on the line at `y`. */
async function write(page: Page, y: number, letters: number, fromLetter = 0, size = 28) {
  const box = await page.getByTestId("notebook-canvas").boundingBox();
  if (!box) throw new Error("canvas not visible");
  for (let i = fromLetter; i < fromLetter + letters; i++) {
    const left = box.x + 180 + i * size * 0.9;
    await page.mouse.move(left, box.y + y + size);
    await page.mouse.down();
    await page.mouse.move(left + size * 0.3, box.y + y, { steps: 4 });
    await page.mouse.move(left + size * 0.6, box.y + y + size, { steps: 4 });
    await page.mouse.up();
  }
}

/** The server's view of the page: each line's latest text and box (removed lines dropped). */
function serverLines(syncs: readonly Sync[]) {
  const lines = new Map<string, NotePageSync["upsert"][number]>();
  for (const { body } of syncs) {
    for (const line of body.upsert) lines.set(line.id, line);
    for (const id of body.remove) lines.delete(id);
  }
  return [...lines.values()];
}

test("every line reaches the server with text, a box and an embedding; edits follow within 3 s", async ({
  page,
}) => {
  await fakeRecognition(page, [
    "enzymes lower activation energy",
    "they are used up in the reaction",
    "enzymes lower the activation energy of a reaction",
  ]);
  const syncs = await recordSyncs(page);
  await page.goto("/notebook");
  await expect(page.getByTestId("notebook-canvas")).toBeVisible();

  await write(page, 120, 4);
  await expect.poll(() => serverLines(syncs).length, { timeout: 10_000 }).toBe(1);
  await write(page, 220, 6);
  await expect.poll(() => serverLines(syncs).length, { timeout: 10_000 }).toBe(2);

  const lines = serverLines(syncs).sort((a, b) => a.lineIndex - b.lineIndex);
  expect(lines.map((l) => [l.lineIndex, l.text, l.source])).toEqual([
    [0, "enzymes lower activation energy", "ink"],
    [1, "they are used up in the reaction", "ink"],
  ]);
  for (const line of lines) {
    expect(line.bbox).toHaveLength(4);
    expect(line.bbox[2]).toBeGreaterThan(50); // a real box around the writing
    expect(line.confidence).toBe(0.92);
  }
  // The API service embedded each line's text once.
  expect(syncs.reduce((n, s) => n + s.result.embedded, 0)).toBe(2);

  // Edit the first line; time from the pen leaving the page to the server having the new text.
  const firstId = lines[0]?.id;
  const syncsBefore = syncs.length;
  await write(page, 120, 3, 4);
  const penUp = Date.now();
  await expect
    .poll(
      () =>
        syncs
          .slice(syncsBefore)
          .some((s) =>
            s.body.upsert.some((u) => u.id === firstId && u.text.includes("of a reaction")),
          ),
      { timeout: 10_000 },
    )
    .toBe(true);
  const updated = syncs
    .slice(syncsBefore)
    .find((s) => s.body.upsert.some((u) => u.id === firstId && u.text.includes("of a reaction")));
  const elapsed = (updated?.at ?? Infinity) - penUp;
  console.log(`[notes e2e] edited line synced ${elapsed} ms after the pen stopped`);
  expect(elapsed).toBeLessThan(3_000);
  // The same line (same id), embedded again because its text changed; the other one wasn't.
  expect(
    serverLines(syncs)
      .map((l) => l.id)
      .sort(),
  ).toEqual(lines.map((l) => l.id).sort());
  expect(updated?.result.embedded).toBe(1);
});

test("nothing is sent while the student has turned Notes Check's copy off", async ({
  page,
  baseURL,
}) => {
  const origin = new URL(baseURL ?? "http://localhost:3000").origin;
  const off = await page.request.patch(`${origin}/api/settings`, {
    data: { notes_index: false },
    headers: { origin },
  });
  expect(off.ok()).toBe(true);
  await fakeRecognition(page, ["a private note"]);
  const syncs = await recordSyncs(page);
  const recognised = page.waitForRequest("**/api/recognize");
  await page.goto("/notebook");
  await expect(page.getByTestId("notebook-canvas")).toBeVisible();

  await write(page, 120, 4);
  await recognised; // the line was read (for the tutor), and kept on the device only
  await page.waitForTimeout(2_500);
  expect(syncs).toEqual([]);
});

// ─── N4: the check's marks in the notebook ───────────────────────────────────────────────────

const CLIP_ID = "55555555-5555-4555-8555-555555555555";
const DB_NAME = "mew-notebooks-local";

/** The student's strokes as stored, to prove marks never change them. */
async function studentStrokes(page: Page): Promise<string> {
  return page.evaluate(
    (name) =>
      new Promise<string>((resolve, reject) => {
        const open = indexedDB.open(name);
        open.onerror = () => reject(new Error("can't open the notebook"));
        open.onsuccess = () => {
          const request = open.result.transaction("strokes").objectStore("strokes").getAll();
          request.onsuccess = () => {
            const strokes = (request.result as { author: string; id: string }[])
              .filter((s) => s.author === "student")
              .sort((a, b) => a.id.localeCompare(b.id));
            resolve(JSON.stringify(strokes));
            open.result.close();
          };
        };
      }),
    DB_NAME,
  );
}

async function mockClip(page: Page) {
  await page.route(`**/api/clips/${CLIP_ID}`, (route) =>
    route.request().method() === "PATCH"
      ? route.fulfill({ json: {} })
      : route.fulfill({
          json: {
            id: CLIP_ID,
            width: 300,
            height: 100,
            pixelRatio: 1,
            strokes: [],
            source: {
              app: "msedge.exe",
              title: "Enzymes lecture",
              url: "https://www.youtube.com/watch?v=abc&t=754",
              timestampSec: 754,
              capturedAt: "2026-10-23T10:00:00.000Z",
            },
            ocrText:
              "Enzymes lower the activation energy\nEnzymes are not consumed by the reaction",
            notebookPageId: null,
            createdAt: "2026-10-23T10:00:01.000+00:00",
          },
        }),
  );
  await page.route(`**/api/clips/${CLIP_ID}/image`, (route) =>
    route.fulfill({ status: 404, body: "" }),
  );
}

test("a clip checked against the notes marks the lines, asks, and never touches the ink", async ({
  page,
}) => {
  await fakeRecognition(page, [
    "enzymes lower activation energy",
    "they are used up in the reaction",
  ]);
  const syncs = await recordSyncs(page);
  await mockClip(page);
  await page.goto("/notebook");
  await expect(page.getByTestId("notebook-canvas")).toBeVisible();
  await write(page, 120, 4);
  await expect.poll(() => serverLines(syncs).length, { timeout: 10_000 }).toBe(1);
  await write(page, 220, 6);
  await expect.poll(() => serverLines(syncs).length, { timeout: 10_000 }).toBe(2);
  const idOf = (text: string) => serverLines(syncs).find((l) => l.text === text)?.id ?? "";
  const lowersId = idOf("enzymes lower activation energy");
  const usedUpId = idOf("they are used up in the reaction");
  const inkBefore = await studentStrokes(page);

  let asked: { screen: { text: string }[]; scope: unknown; clipId: string } | null = null;
  await page.route("**/api/notes/check", (route) => {
    asked = route.request().postDataJSON() as typeof asked;
    return route.fulfill({
      json: {
        checkId: "44444444-4444-4444-8444-444444444444",
        related: true,
        topic: "Enzymes",
        speech: "Most of this matches your notes. There's one line I'd like you to look at again.",
        scopeLabel: "Compared with My first notebook, page 1",
        pages: [],
        findings: [
          {
            id: "66666666-6666-4666-8666-000000000001",
            type: "difference",
            lineIds: [usedUpId],
            blockIds: ["b2"],
            noteQuote: "used up",
            screenQuote: "not consumed",
            question: "Your notes say enzymes get used up. What does the slide say?",
            sourceConflict: false,
            confidence: 0.93,
            evidence: ["model", "second_opinion"],
          },
          {
            id: "66666666-6666-4666-8666-000000000002",
            type: "match",
            lineIds: [lowersId],
            blockIds: ["b1"],
            noteQuote: "enzymes lower activation energy",
            screenQuote: "Enzymes lower the activation energy",
            sourceConflict: false,
            confidence: 0.95,
            evidence: ["model"],
          },
        ],
        source: { clipId: CLIP_ID },
        latencyMs: 2100,
      },
    });
  });

  // The clip's page: offered a check once, never run without asking.
  await page.goto(`/notebook?clip=${CLIP_ID}`);
  const prompt = page.getByTestId("notes-check-prompt");
  await expect(prompt).toBeVisible();
  expect(asked).toBeNull();
  await prompt.getByRole("button", { name: "Check" }).click();

  const panel = page.getByTestId("notes-check-panel");
  await expect(panel).toContainText("Compared with My first notebook, page 1");
  await expect(panel).toContainText("One line to look at again");
  expect(asked).toMatchObject({
    clipId: CLIP_ID,
    scope: { kind: "notebook" },
    screen: [
      { blockId: "b1", text: "Enzymes lower the activation energy" },
      { blockId: "b2", text: "Enzymes are not consumed by the reaction" },
    ],
  });

  // "Show me" opens the page with that line; its mark asks the question.
  await panel.getByRole("button", { name: "Show me" }).click();
  const question = page.getByRole("button", { name: /Question about this line/ });
  await expect(question).toBeVisible();
  await expect(page.getByTestId("mark-match")).toHaveCount(1);
  await question.click();
  await expect(page.getByRole("dialog", { name: "Notes Check" })).toContainText(
    "What does the slide say?",
  );
  await page.keyboard.press("Escape");

  // Hiding the marks hides them; the ink is exactly as it was throughout.
  await panel.getByRole("button", { name: "Hide marks on the page" }).click();
  await expect(page.getByTestId("mark-question")).toHaveCount(0);
  await panel.getByRole("button", { name: "Show marks on the page" }).click();
  await expect(page.getByTestId("mark-question")).toHaveCount(1);
  expect(await studentStrokes(page)).toBe(inkBefore);
});

test("an open finding comes back after a reload, and answering it settles its mark (N5)", async ({
  page,
}) => {
  await fakeRecognition(page, ["they are used up in the reaction"]);
  const syncs = await recordSyncs(page);
  await page.goto("/notebook");
  await expect(page.getByTestId("notebook-canvas")).toBeVisible();
  await write(page, 160, 6);
  await expect.poll(() => serverLines(syncs).length, { timeout: 10_000 }).toBe(1);
  const lineId = serverLines(syncs)[0]?.id ?? "";
  const inkBefore = await studentStrokes(page);

  // An earlier check left this finding open on the server.
  const findingId = "77777777-7777-4777-8777-000000000001";
  await page.route("**/api/notes/findings?*", (route) => {
    const pageId = new URL(route.request().url()).searchParams.get("pageId");
    return route.fulfill({
      json: [
        {
          id: findingId,
          checkId: "77777777-7777-4777-8777-000000000002",
          type: "difference",
          noteLineIds: [lineId],
          pageId,
          noteQuote: "used up",
          screenSnippet: "Enzymes are not consumed by the reaction",
          question: "Your notes say enzymes get used up. What does the slide say?",
          explanation: "Consumed vs not consumed.",
          conceptHint: "Enzymes",
          conceptId: null,
          confidence: 0.9,
          sourceConflict: false,
          status: "open",
          courseId: null,
        },
      ],
    });
  });
  let answered: unknown = null;
  await page.route(`**/api/notes/findings/${findingId}/resolve`, (route) => {
    answered = route.request().postDataJSON();
    return route.fulfill({
      json: {
        outcome: "fixed",
        reply: "Yes, that's what the slide says.",
        status: "resolved_fixed",
      },
    });
  });

  await page.reload();
  const question = page.getByRole("button", { name: /Question about this line/ });
  await expect(question).toBeVisible({ timeout: 10_000 });
  await question.click();
  const card = page.getByRole("dialog", { name: "Notes Check" });
  await card.getByPlaceholder("Your answer").fill("they are not consumed");
  await card.getByRole("button", { name: "Check my answer" }).click();

  await expect(card.getByTestId("finding-reply")).toHaveText("Yes, that's what the slide says.");
  expect(answered).toEqual({ reply: "they are not consumed" });
  await expect(page.getByTestId("mark-question")).toHaveAttribute("data-settled", "true");
  await expect(page.getByRole("button", { name: "Worked through" })).toBeVisible();
  expect(await studentStrokes(page)).toBe(inkBefore);
});
