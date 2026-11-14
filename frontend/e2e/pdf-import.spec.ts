import { expect, test } from "./fixtures";

import { CHAPTER, makePdf } from "./helpers/pdf";

/** K4: every page of a PDF imported into the notebook already open can be reached at once. */
test("a PDF imported into the open notebook shows all its pages", async ({ page }) => {
  await page.route("**/api/stt/token", (route) => route.abort());
  await page.goto("/notebook");
  await expect(page.getByTestId("pencil-case")).toBeVisible();
  const pages = page.getByRole("navigation", { name: "Pages" });
  await expect(pages).toContainText("1 of 1");

  await page.keyboard.press("Control+o");
  const dialog = page.getByRole("dialog", { name: "Import a PDF" });
  await dialog.locator('input[type="file"]').setInputFiles({
    name: "chapter-3.pdf",
    mimeType: "application/pdf",
    buffer: makePdf(CHAPTER),
  });
  await expect(dialog).toContainText("3 pages");
  await dialog.getByRole("checkbox", { name: /Use as course material/ }).uncheck();
  await dialog.getByRole("button", { name: "Import", exact: true }).click();

  // The new pages follow the page that was there, and the first of them opens.
  await expect(pages).toContainText("2 of 4");
  await pages.getByRole("button", { name: "Next page" }).click();
  await expect(pages).toContainText("3 of 4");
  await pages.getByRole("button", { name: "Next page" }).click();
  await expect(pages).toContainText("4 of 4");
});
