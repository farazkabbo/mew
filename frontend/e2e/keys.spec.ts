import { expect, test } from "./fixtures";

/**
 * U7 (docs/NEB_APP_UI.md §5.6, board 6): "two keys, max". Holding Alt shows every control's keys
 * and letting go hides them; Shift+? (or the ask pill's "?") opens the shortcuts sheet.
 */

test("holding Alt shows the keys, and Shift+? opens the sheet", async ({ page }) => {
  await page.route("**/api/stt/token", (route) => route.abort());
  await page.goto("/notebook");
  await expect(page.getByTestId("pencil-case")).toBeVisible();

  // A tap of Alt does nothing; a hold of 400 ms shows the keys until it's let go.
  await page.keyboard.down("Alt");
  await page.keyboard.up("Alt");
  await expect(page.getByTestId("keytips")).toHaveCount(0);
  await page.keyboard.down("Alt");
  const tips = page.getByTestId("keytips");
  await expect(tips).toBeVisible();
  await expect(tips).toContainText("Alt"); // Check my work, Alt+C
  await page.keyboard.up("Alt");
  await expect(tips).toHaveCount(0);

  await page.keyboard.press("Shift+Slash");
  const sheet = page.getByTestId("shortcuts-sheet");
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole("heading", { name: "Two keys, max." })).toBeVisible();
  await expect(sheet).toContainText("Jump to any page or moment");
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();

  await page.getByRole("button", { name: "Shortcuts and what to say" }).click();
  await expect(sheet).toBeVisible();
  await sheet.getByRole("button", { name: "Close" }).click();
  await expect(sheet).toBeHidden();
});
