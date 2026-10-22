import { randomBytes } from "node:crypto";

import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const ci = Boolean(process.env.CI);
/** The test server listens on the base URL's port (set E2E_BASE_URL to avoid a dev server on :3000). */
const port = new URL(baseURL).port || "3000";
/** The API service (SymPy checks) for the test run, on its own port. */
const apiPort = process.env.E2E_API_PORT ?? "8100";
const apiURL = `http://127.0.0.1:${apiPort}`;
/** A throwaway secret shared by the two test servers (never the real one). */
const internalSecret = randomBytes(24).toString("hex");

/**
 * End-to-end tests against the running web app. Uses an installed browser channel
 * (`E2E_CHANNEL`, default Microsoft Edge) so no browser download is needed locally.
 */
export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  // One at a time: the tests depend on real timing (pen pauses, recognition, checks) against a
  // single dev server, and parallel workers starve it into flaky timeouts.
  workers: 1,
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
  webServer: [
    {
      // The real API service, so maths checks run through SymPy end to end.
      command: `uv run --frozen uvicorn --factory mew_api.main:create_app --host 127.0.0.1 --port ${apiPort}`,
      cwd: "../backend",
      // No model or database keys: courses use the local store and the model-free fallbacks.
      env: {
        INTERNAL_API_SECRET: internalSecret,
        APP_ENV: "development",
        ALLOWED_HOSTS: "127.0.0.1,localhost",
        GEMINI_API_KEY: "",
        SUPABASE_SECRET_KEY: "",
      },
      url: `${apiURL}/health`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: `node scripts/copy-pyodide.mjs && node scripts/copy-transformers.mjs && pnpm exec next dev --port ${port}`,
      // Like CI: local mode (no sign-in) and no model or speech keys, even when .env.local has
      // them (an empty variable in the environment wins over the file). Tests mock what they
      // need, so runs are deterministic and spend no credits. Its own build folder lets it run
      // next to a `next dev` you already have open.
      env: {
        NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "",
        CLERK_SECRET_KEY: "",
        GEMINI_API_KEY: "",
        ELEVENLABS_API_KEY: "",
        APP_ORIGIN: new URL(baseURL).origin,
        API_BASE_URL: apiURL,
        INTERNAL_API_SECRET: internalSecret,
        NEXT_DIST_DIR: ".next-e2e",
      },
      // Waiting on the notebook route (not just "/") makes the first test start on a compiled page.
      url: `${baseURL}/notebook`,
      reuseExistingServer: true,
      timeout: 180_000,
    },
  ],
});
