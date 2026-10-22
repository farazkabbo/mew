import { DEFAULT_SETTINGS } from "@mew/shared";
import { test as base } from "@playwright/test";

export * from "@playwright/test";

/**
 * Every test starts from the default settings with the first-run introduction already seen.
 * Settings live in the API service's (local mode) profile, which all tests in a run share, so
 * this also stops one test's settings from leaking into the next. Tests of the introduction
 * reset `onboarded` themselves.
 */
export const test = base.extend<{ freshSettings: void }>({
  freshSettings: [
    async ({ request, baseURL }, use) => {
      const origin = new URL(baseURL ?? "http://localhost:3000").origin;
      const response = await request.patch(`${origin}/api/settings`, {
        data: { ...DEFAULT_SETTINGS, onboarded: true },
        headers: { origin },
      });
      if (!response.ok()) throw new Error(`resetting settings failed: ${response.status()}`);
      await use();
    },
    { auto: true },
  ],
});
