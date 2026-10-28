import { expect, test } from "./fixtures";

/**
 * The desk (docs/NEB_APP_UI.md §5.1, U4): the app's home. A first run is one dashed cover; a
 * notebook (named first, always) becomes a cover, Tonight offers to resume it, and a cover opens it.
 */

test.beforeEach(({ page }) => {
  page.on("console", (message) => {
    if (/Content.Security.Policy|Refused to/i.test(message.text())) {
      throw new Error(`CSP violation: ${message.text()}`);
    }
  });
});

const SHOTS = "test-results/desk";

test("a first run is one dashed cover; a named notebook becomes a cover you can open", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  await page.goto("/desk");
  const desk = page.getByTestId("desk");
  await expect(desk).toBeVisible();
  await expect(desk.getByRole("heading", { level: 1 })).toHaveText(
    /^(Good (morning|afternoon|evening)|Late one)\.$/,
  );
  await expect(page.getByTestId("desk-empty")).toBeVisible();
  await expect(page.getByTestId("tonight")).toContainText("All clear.");
  await page.screenshot({ path: `${SHOTS}/first-run.png` });

  // Named first: the dashed cover opens the naming dialog; nothing is made unnamed.
  await page.getByTestId("desk-new-notebook").click();
  const dialog = page.getByRole("dialog", { name: "New notebook" });
  await dialog.getByLabel("Name").fill("Physics");
  await dialog.getByLabel("Number of chapters").fill("3");
  await dialog.getByRole("button", { name: "Create" }).click();
  await expect(page.getByTestId("node-home")).toBeVisible();

  // Back on the desk: the cover, its chapters, and Tonight's "Resume".
  await page.goto("/desk");
  const cover = page.getByTestId("desk-cover");
  await expect(cover).toHaveCount(1);
  await expect(cover.getByRole("button")).toHaveAccessibleName(
    /^Physics, 3 chapters · \d+ pages?$/,
  );
  await expect(page.getByTestId("tonight-resume")).toContainText("Physics");
  await page.screenshot({ path: `${SHOTS}/one-notebook.png` });
  await page.getByRole("button", { name: /Jump to any page or moment/ }).screenshot({
    path: `${SHOTS}/jump-pill.png`,
  });

  await page.emulateMedia({ colorScheme: "dark" });
  await page.screenshot({ path: `${SHOTS}/one-notebook-night.png` });

  await cover.getByRole("button").click();
  await expect(page.getByTestId("desk")).toBeHidden();
  await expect(page.getByTestId("node-home")).toBeVisible();
});

test("the desk's header jumps anywhere and starts a notebook, with two keys", async ({ page }) => {
  await page.goto("/desk");
  await expect(page.getByTestId("desk")).toBeVisible();
  await page.keyboard.press("Alt+b");
  await expect(page.getByRole("dialog", { name: "New notebook" })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: /Jump to any page or moment/ }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
});
