# Testing the launch work

What to check before anything is merged. Nothing is merged to `main` yet, and nothing should be
until the preview journey passes.

- **App** (`mew`): branch `feat/launch-limits`
- **Website** (`neb_web`): branch `review/launch-mode`

> **Live keys:** both repos' `.env.local` files hold **live** keys (the real waitlist, real Resend
> email, Gemini, ElevenLabs, Supabase). Don't run the website or app servers locally with them
> loaded. The automated tests below already blank them. For anything else, use staging keys.

## 1. Automated (about 15 minutes, in `mew`)

```sh
pnpm install
pnpm check                                        # format, lint, types, all unit tests
cd desktop/src-tauri && cargo test --lib && cargo clippy --all-targets -- -D warnings
cd ../.. && pnpm --filter @mew/frontend journey   # steps 1–12 with the fake model, keys blanked
pnpm --filter @mew/frontend build && pnpm scan:secrets   # no keys in anything that ships
```

All of these should pass. Three Playwright tests in the regular e2e suite already fail on `main`
and aren't new: two screenshot comparisons and the draw-overlay test.

## 2. On a preview deploy (needs Vercel and staging access)

- **Deploy:** the app branch to a Vercel preview with `NEB_FAKE_MODEL=1`, a placeholder
  `GEMINI_API_KEY`, staging Supabase and Clerk keys, and Upstash
  (`UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`).
- **Apply:** every migration in `backend/supabase/migrations` (a new staging project needs all of
  them, ending with `20261112000000_question_quota.sql` and `20261113000000_quota_notify.sql`)
  to the **staging** Supabase project only.
- **For the journey only:** set `ASK_PER_MINUTE`, `ASK_PER_HOUR` and `ASK_IP_PER_MINUTE` to
  `1000` on the preview (it asks faster than the real 3-a-minute limit). Remove them and redeploy
  before k6, which should hit the real limits.
- **Journey:**

  ```sh
  JOURNEY_BASE_URL=<preview> JOURNEY_DEVICE_TOKEN=<fresh test account's device token> \
  JOURNEY_SITE_URL=<neb_web preview with LAUNCH_MODE=open> pnpm --filter @mew/frontend journey
  ```

- **Load test:** `k6 run -e BASE_URL=<preview> -e DEVICE_TOKENS=<tokens> loadtest/limits.k6.js`.
  Report p95 latency, the error rate, and how many requests hit `RATE_LIMITED` and
  `QUOTA_EXCEEDED`.
- **Database race:**
  `STAGING_SUPABASE_URL=… STAGING_SUPABASE_SECRET_KEY=… node scripts/staging-quota-race.mjs`.
  It should report exactly 8 reservations through and 12 refused. It refuses to run against
  production.

## 3. On a real Windows PC (against the preview, with a release build pointed at it)

1. Install from `/download` without an account. Open neb, click **Sign in**: the browser should
   show **sign-up**.
2. Sign up with Google. The page asks "Connect neb on a Windows PC, started just now?" Click
   **Continue**: the app should greet you within a few seconds.
3. Do it again with `neb://` links blocked in Edge. The app should still connect, by polling,
   about 2 seconds after **Continue**.
4. Start a sign-in and click **This wasn't me**. The app should say it was cancelled, and nothing
   connects.
5. Ask one question: the desk shows "7 of 8 questions left". A follow-up in the same circle and
   walkthrough steps shouldn't change it.
6. Turn Wi-Fi off mid-answer. You get an error and still have 7.
7. Use all 8. Expect one notice at 2 left, then "We'll email you at a•••@… when more open up".
   The notebook, Replay and PDF export should still work.
8. Reinstall neb and sign in with a **second** account on the same PC: still 0 left.
9. On the website: Settings → Signed-in devices → **Sign out**. The app's next question should
   ask you to connect again.

## 4. Website (preview of `review/launch-mode`, `LAUNCH_MODE=open`)

- "Get neb" goes to `/download`, with no sign-up.
- `/download` on Windows offers the installer. On Mac it says "Windows-only for now".
- "Email me the link" arrives (send it to your own address only). The 4th try in a day for one
  email is refused.
- "Already have an account? Sign in" goes to the app's sign-in.
- With `LAUNCH_MODE=waitlist`, the home page should be exactly as it is today.

## What to send back

Pass or fail for each step, a screenshot of any wrong message, and the k6 numbers. Don't merge
either branch.

More detail: [LAUNCH_LIMITS.md](LAUNCH_LIMITS.md) (the plan and checklists) and
[DESKTOP_API.md](DESKTOP_API.md) (the API contract).
