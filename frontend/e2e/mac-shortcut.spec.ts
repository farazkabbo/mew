import { expect, test } from "@playwright/test";

for (const registered of [true, false, null]) {
  test(`Mac summon instructions reflect registration: ${registered}`, async ({ page }) => {
    await page.addInitScript((ready) => {
      Object.defineProperty(navigator, "platform", { value: "MacIntel" });
      Object.assign(window, {
        __TAURI_INTERNALS__: {},
        __TAURI__: {
          core: {
            invoke: (command: string) => {
              if (command === "desktop_summon_shortcut" && ready !== null)
                return Promise.resolve(ready);
              return Promise.reject(new Error("Unsupported command"));
            },
          },
        },
      });
    }, registered);
    await page.goto("/settings#shortcuts");
    if (registered) {
      await expect(page.getByText("Control + Shift + N", { exact: true })).toBeVisible();
      await expect(page.getByText(/Open Neb from any app/)).toBeVisible();
    } else {
      await expect(page.getByText(/shortcut is unavailable/)).toBeVisible();
    }
    await expect(page.getByText("Ctrl+Alt", { exact: true })).toHaveCount(0);
  });
}

test("Mac Control+Option does not activate the notebook hold gesture", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "platform", { value: "MacIntel" });
    navigator.mediaDevices.getUserMedia = () => {
      document.documentElement.dataset.unexpectedMic = "1";
      return Promise.reject(new Error("No microphone in this test"));
    };
  });
  await page.goto("/notebook");
  await expect(page.getByTestId("notebook-canvas")).toBeVisible();
  await page.keyboard.down("ControlLeft");
  await page.keyboard.down("AltLeft");
  // Outlast the hold guard: VoiceOver's modifier must never begin a Neb hold.
  await page.waitForTimeout(600);
  await expect(page.getByTestId("hold-circle")).toHaveCount(0);
  await expect(page.locator("html")).not.toHaveAttribute("data-unexpected-mic", "1");
  await page.keyboard.up("AltLeft");
  await page.keyboard.up("ControlLeft");
});
