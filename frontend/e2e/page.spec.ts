import { expect, type Page, test } from "./fixtures";

/**
 * U2 (docs/NEB_APP_UI.md §4, board 2): the page. A header (back to the desk, where you are, how
 * much neb marks, Fold the margin), the pencil case, the sheet with neb's lane, the chapter tabs
 * and the replay bar. A wrong step's circle stays on the page; its words are a note in the lane.
 */

type Reading = { text: string; latex: string | null };
const SHOTS = "test-results/page";

test.beforeEach(({ page }) => {
  page.on("console", (message) => {
    if (/Content.Security.Policy|Refused to/i.test(message.text())) {
      throw new Error(`CSP violation: ${message.text()}`);
    }
  });
});

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
  await page.route("**/api/stt/token", (route) => route.abort());
  await page.route("**/api/annotations", (route) => route.fulfill({ json: { saved: 1 } }));
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

test("the page: header, pencil case, sheet with neb's lane, chapter tabs, replay bar", async ({
  page,
}) => {
  test.setTimeout(90_000);
  // The drawer closed, as a new student sees it.
  await page.addInitScript(() => localStorage.setItem("neb:contents", "0"));
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  await fakeServices(page, [
    { text: "3x + 7 = 19", latex: "3x+7=19" },
    { text: "3x = 26", latex: "3x=26" },
  ]);

  // A notebook with chapters, from the desk.
  await page.goto("/desk");
  await page.getByTestId("desk-new-notebook").click();
  const dialog = page.getByRole("dialog", { name: "New notebook" });
  await dialog.getByLabel("Name").fill("Physics");
  await dialog.getByLabel("Number of chapters").fill("4");
  await dialog.getByRole("button", { name: "Create" }).click();
  await expect(page.getByTestId("node-home")).toBeVisible();
  await page
    .getByTestId("node-home")
    .getByRole("button", { name: /Chapter 3/ })
    .first()
    .click();

  await expect(page.getByTestId("sheet")).toBeVisible();
  await expect(page.getByTestId("page-header")).toContainText("Physics");
  await expect(page.getByTestId("pencil-case")).toBeVisible();
  await expect(page.getByTestId("neb-lane")).toBeVisible();
  await expect(page.getByTestId("replay-bar")).toBeVisible();
  const tabs = page.getByTestId("chapter-tabs");
  await expect(tabs.getByRole("button", { name: /^3 · Chapter 3/ })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(page.getByRole("radio", { name: "Hint" })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("tree")).toBeHidden(); // the Contents drawer is closed
  await page.screenshot({ path: `${SHOTS}/empty.png` });

  // A wrong step: the circle on the page, the words in the lane.
  await writeLine(page, 120, 120, 7);
  await page.waitForTimeout(2000);
  await writeLine(page, 120, 190, 4);
  const note = page.getByTestId("neb-note");
  await expect(note).toBeVisible({ timeout: 15_000 });
  await expect(note.getByTestId("live-mark")).toHaveAttribute("aria-label", "Mark: sign?");
  await expect(note).toContainText("sign?");
  await page.screenshot({ path: `${SHOTS}/marked.png` });

  // Fold the margin: the lane is a strip with the count.
  await page.getByRole("button", { name: /Fold the margin/ }).click();
  await expect(page.getByTestId("neb-lane")).toHaveAttribute("data-folded", "true");
  await page.getByTestId("neb-lane").click();
  await expect(page.getByTestId("neb-lane")).not.toHaveAttribute("data-folded", "true");

  // Another chapter's tab opens it; the Contents drawer opens on demand; back to the desk.
  await tabs.getByRole("button", { name: /^1 · Chapter 1/ }).click();
  await expect(tabs.getByRole("button", { name: /^1 · Chapter 1/ })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await page.getByRole("button", { name: "Contents" }).click();
  await expect(page.getByRole("tree")).toBeVisible();
  await page.getByRole("button", { name: "Back to the desk" }).click();
  await expect(page.getByTestId("desk")).toBeVisible();
});
