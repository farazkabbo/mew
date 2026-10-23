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
