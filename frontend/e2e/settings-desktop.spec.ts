import { expect, type Page, test } from "./fixtures";

async function mockDesktop(page: Page, screenCoachExists: boolean) {
  await page.addInitScript((exists) => {
    Object.assign(window, {
      __TAURI_INTERNALS__: {},
      __TAURI__: {
        core: {
          invoke: (command: string, args?: { openSettings?: boolean }) => {
            if (command !== "screen_coach_onboarding") return Promise.resolve(null);
            if (!exists) return Promise.reject(new Error("Screen Coach is unavailable"));
            if (args?.openSettings) {
              document.documentElement.dataset.coachSettingsOpened = "1";
            }
            return Promise.resolve(false);
          },
        },
      },
    });
  }, screenCoachExists);
}

test("native settings omit unavailable Screen Coach controls", async ({ page }) => {
  await mockDesktop(page, false);
  await page.goto("/settings");
  // Reminders are supported independently of Screen Coach in the installed Mac app.
  await expect(page.getByRole("checkbox", { name: /Tell me when checks are due/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open desktop settings" })).toHaveCount(0);
});

test("native settings open Screen Coach even when it is switched off", async ({ page }) => {
  await mockDesktop(page, true);
  await page.goto("/settings");
  await page.getByRole("button", { name: "Open desktop settings" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-coach-settings-opened", "1");
});
