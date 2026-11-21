import { expect, test } from "./fixtures";

test("browser extension attributes on the body preserve hydration and interaction", async ({
  page,
}) => {
  const hydrationErrors: string[] = [];
  page.on("console", (message) => {
    if (/hydrat|server rendered.*match/i.test(message.text())) {
      hydrationErrors.push(message.text());
    }
  });
  page.on("pageerror", (error) => {
    if (/hydrat|server rendered.*match/i.test(error.message)) {
      hydrationErrors.push(error.message);
    }
  });

  // Browser extensions can change body attributes before React hydrates the page.
  await page.addInitScript(() => {
    const inject = () => {
      if (!document.body) return false;
      document.body.setAttribute("data-new-gr-c-s-check-loaded", "14.1349.0");
      document.body.setAttribute("data-gr-ext-installed", "");
      return true;
    };
    if (inject()) return;
    const observer = new MutationObserver(() => {
      if (inject()) observer.disconnect();
    });
    observer.observe(document, { childList: true, subtree: true });
  });

  await page.goto("/desk");
  await expect(page.locator("body")).toHaveAttribute("data-gr-ext-installed", "");
  await expect(page.getByTestId("desk")).toBeVisible();
  await page.getByTestId("desk-new-notebook").click();
  await expect(page.getByRole("dialog", { name: "New notebook" })).toBeVisible();
  expect(hydrationErrors).toEqual([]);
});
