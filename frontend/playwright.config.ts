import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const ci = Boolean(process.env.CI);

/**
 * End-to-end tests against the running web app. Uses an installed browser channel
 * (`E2E_CHANNEL`, default Microsoft Edge) so no browser download is needed locally.
 */
export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  forbidOnly: ci,
  retries: 0,
  // CI runners compile the dev server cold on small VMs: allow more time there only.
  timeout: ci ? 90_000 : 30_000,
  expect: { timeout: ci ? 15_000 : 5_000 },
  reporter: ci ? [["list"], ["html", { open: "never" }]] : [["list"]],
  use: {
    ...devices["Desktop Edge"],
    channel: process.env.E2E_CHANNEL ?? "msedge",
    baseURL,
    viewport: { width: 1280, height: 800 },
    trace: "retain-on-failure",
  },
  webServer: {
    command: "pnpm dev",
    // Waiting on the notebook route (not just "/") makes the first test start on a compiled page.
    url: `${baseURL}/notebook`,
    reuseExistingServer: true,
    timeout: 180_000,
  },
});
