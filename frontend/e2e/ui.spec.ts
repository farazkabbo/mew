import { expect, test } from "./fixtures";

/**
 * U1 (docs/NEB_APP_UI.md §3, §12): the design tokens in light and night, the components'
 * states on /dev/ui, focus that's ink (never violet), and the Appearance and Text size settings
 * applied before the first paint.
 */

test.beforeEach(({ page }) => {
  page.on("console", (message) => {
    if (/Content.Security.Policy|Refused to/i.test(message.text())) {
      throw new Error(`CSP violation: ${message.text()}`);
    }
  });
});

const SECTIONS = ["colors", "type", "buttons", "keycaps", "dot", "review", "review-more"] as const;

for (const colorScheme of ["light", "dark"] as const) {
  test(`every U1 component renders in the ${colorScheme === "light" ? "light" : "night"} theme`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
    await page.goto("/dev/ui");
    await expect(page.getByTestId("ui-preview")).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    for (const section of SECTIONS) {
      await expect(page.getByTestId(`ui-${section}`)).toHaveScreenshot(
        `${section}-${colorScheme === "light" ? "light" : "night"}.png`,
        { animations: "disabled", maxDiffPixels: 30 },
      );
    }
  });
}

test("Review's folders: a tab brings its folder to the front, arrows move along, More holds the rest", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  await page.goto("/dev/ui");
  const folders = page.getByTestId("ui-review").getByTestId("review-folders");
  const tabs = folders.getByRole("tab");
  await expect(tabs).toHaveCount(4);
  // Most to revisit first: EECS (2), then Business Maths and NATS (1 each, Business has more new).
  await expect(tabs.first()).toHaveAttribute("aria-selected", "true");
  await expect(folders.getByRole("tabpanel").first()).toContainText("Amortized analysis");

  await tabs.nth(1).click();
  await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");
  const front = folders.locator('[role="tabpanel"][aria-hidden="false"]');
  await expect(front).toContainText("Business Mathematics");
  await expect(front.getByTestId("review-item").first()).toContainText("Simple Discount");
  await expect(front.getByRole("link", { name: /Quiz me/ })).toContainText("2");

  await page.keyboard.press("ArrowRight");
  await expect(tabs.nth(2)).toBeFocused();
  await expect(tabs.nth(2)).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Home");
  await expect(tabs.first()).toHaveAttribute("aria-selected", "true");

  // Nine courses: seven tabs, and More with the other two.
  const many = page.getByTestId("ui-review-more").getByTestId("review-folders");
  await expect(many.getByRole("tab")).toHaveCount(7);
  await many.getByRole("button", { name: /More/ }).click();
  await many.getByRole("button", { name: /Philosophy/ }).click();
  const last = many.getByRole("tab").last();
  await expect(last).toContainText("Philosophy");
  await expect(last).toHaveAttribute("aria-selected", "true");
});

test("the page background is the desk, and night follows the OS", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/dev/ui");
  const background = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(await background()).toBe("rgb(236, 230, 216)"); // --desk, light
  await page.emulateMedia({ colorScheme: "dark" });
  expect(await background()).toBe("rgb(27, 31, 35)"); // --desk, night
});

test("focus is a 2 px ink ring, never violet", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/dev/ui");
  const first = page.getByTestId("ui-buttons").getByRole("button").first();
  await first.focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await expect(first).toBeFocused();
  const outline = await first.evaluate((el) => {
    const style = getComputedStyle(el);
    return { color: style.outlineColor, width: style.outlineWidth, offset: style.outlineOffset };
  });
  expect(outline).toEqual({ color: "rgb(30, 29, 26)", width: "2px", offset: "2px" });
});

test("Appearance and Text size are kept on this device and applied before the first paint", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/settings");
  const appearance = page.getByTestId("appearance");
  await appearance.getByLabel("Night desk").check();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "night");

  const slider = page.getByRole("slider", { name: /Text size/ });
  await slider.fill("1.2");
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.style.getPropertyValue("--text-scale")),
    )
    .toBe("1.2");

  // A fresh load is night from the very first frame (the inline script, under the CSP).
  await page.goto("/dev/ui");
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe("night");
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(
    "rgb(27, 31, 35)",
  );
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).fontSize)).toBe(
    "19.2px",
  );

  // Back to the device's own setting.
  await page.goto("/settings");
  // The saved choice shows once the page has read this device's storage.
  await expect(page.getByTestId("appearance").getByLabel("Night desk")).toBeChecked();
  await page.getByTestId("appearance").getByLabel("Same as this device").check();
  await expect(page.locator("html")).not.toHaveAttribute("data-theme", /.+/);
});

test("the neb dot replaces the mascot in the notebook", async ({ page }) => {
  await page.goto("/notebook");
  const dot = page.locator("[data-mascot-state] [data-neb-dot]");
  await expect(dot).toBeVisible();
  await expect(page.getByRole("button", { name: /^Ask neb\. neb is/ })).toBeVisible();
});
