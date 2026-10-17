import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:3000";

/**
 * End-to-end tests against the running web app. Uses an installed browser channel
 * (`E2E_CHANNEL`, default Microsoft Edge) so no browser download is needed.
 */
export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: [["list"]],
  use: {
    ...devices["Desktop Edge"],
    channel: process.env.E2E_CHANNEL ?? "msedge",
    baseURL,
    viewport: { width: 1280, height: 800 },
    trace: "retain-on-failure",
  },
  webServer: {
    command: "pnpm dev",
    url: baseURL,
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
