import { randomBytes } from "node:crypto";

import { defineConfig, devices } from "@playwright/test";

/**
 * The launch journey (docs/LAUNCH_LIMITS.md), steps 1–12, with the fake model.
 *
 * - Locally (no JOURNEY_BASE_URL): its own Next (:3200) and API (:8200), in local mode, with the
 *   allowance on (NEB_QUOTA=on), the fake model, and every live key blanked, so nothing real is
 *   called or written.
 * - On a preview deploy: JOURNEY_BASE_URL=https://<preview>, JOURNEY_DEVICE_TOKEN=<a test account's
 *   device token, fresh: 8 questions left>, and JOURNEY_SITE_URL=<neb_web preview, LAUNCH_MODE=open>.
 *   The preview must run NEB_FAKE_MODEL=1 (never production; the build refuses it).
 *
 *   pnpm --filter @mew/frontend journey
 */
const remote = process.env.JOURNEY_BASE_URL;
const baseURL = remote ?? "http://localhost:3200";
const apiPort = "8200";
const internalSecret = randomBytes(24).toString("hex");

export default defineConfig({
  testDir: "e2e-journey",
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  use: {
    ...devices["Desktop Edge"],
    channel: process.env.E2E_CHANNEL ?? "msedge",
    baseURL,
  },
  webServer: remote
    ? []
    : [
        {
          command: `uv run --frozen uvicorn --factory mew_api.main:create_app --host 127.0.0.1 --port ${apiPort}`,
          cwd: "../backend",
          env: {
            INTERNAL_API_SECRET: internalSecret,
            APP_ENV: "development",
            ALLOWED_HOSTS: "127.0.0.1,localhost",
            GEMINI_API_KEY: "",
            SUPABASE_URL: "",
            SUPABASE_SECRET_KEY: "",
          },
          url: `http://127.0.0.1:${apiPort}/health`,
          reuseExistingServer: false,
          timeout: 120_000,
        },
        {
          command: "pnpm exec next dev --port 3200",
          env: {
            NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "",
            CLERK_SECRET_KEY: "",
            CLERK_WEBHOOK_SECRET: "",
            // A placeholder so the routes run; the fake model never calls Gemini or ElevenLabs.
            GEMINI_API_KEY: "fake-model",
            ELEVENLABS_API_KEY: "",
            UPSTASH_REDIS_REST_URL: "",
            UPSTASH_REDIS_REST_TOKEN: "",
            NEXT_PUBLIC_SUPABASE_URL: "",
            SUPABASE_SECRET_KEY: "",
            NEB_FAKE_MODEL: "1",
            NEB_QUOTA: "on",
            FREE_QUESTION_LIMIT: "8",
            // The journey asks quickly; the 3-a-minute limit has its own unit test.
            ASK_PER_MINUTE: "1000",
            ASK_PER_HOUR: "1000",
            ASK_IP_PER_MINUTE: "1000",
            APP_ORIGIN: baseURL,
            API_BASE_URL: `http://127.0.0.1:${apiPort}`,
            INTERNAL_API_SECRET: internalSecret,
            NEXT_DIST_DIR: ".next-journey",
          },
          url: `${baseURL}/notebook`,
          reuseExistingServer: false,
          timeout: 240_000,
        },
      ],
});
