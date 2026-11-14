# Hosting neb in production

How to put the app live at **app.myneb.si**, with its backend and database, **without touching
the website**. myneb.si stays on the waitlist until launch day, when only the website is
switched over (the last section).

The test copy is separate and stays as it is ([PREVIEW_SETUP.md](PREVIEW_SETUP.md)). Nothing here
changes it.

## What runs where

| Piece                | Service                      | Production                              |
| -------------------- | ---------------------------- | --------------------------------------- |
| Web app + server API | Vercel project `neb-app`     | `main` branch → app.myneb.si            |
| Backend (FastAPI)    | Render, Docker               | a new service built from `main`         |
| Database             | Supabase                     | project `gvwynloprjomqqovpoem` (exists) |
| Limits, daily cap    | Upstash Redis                | a new database `neb-prod`               |
| Sign-in              | Clerk                        | development or production instance      |
| AI                   | Gemini, ElevenLabs           | the real keys (already in `.env.local`) |
| DNS for myneb.si     | Wix (`ns12/ns13.wixdns.net`) | one new record: `app`                   |
| Website              | Vercel project `neb-web`     | untouched until launch day              |

## Rules for the whole setup

- **Values go in files, never in chat or commits.** Use `.env.production-values` at the repo
  root (git ignores `.env.*`). Paste each value there as you get it.
- **Production gets its own secrets:** a new `INTERNAL_API_SECRET`, a new Upstash database. Never
  the test copy's.
- **Never `NEB_FAKE_MODEL` in production.** The build refuses it anyway.
- **Asking starts switched off** (`NEB_ASK_ENABLED=false`). It's turned on only after the smoke
  test passes.

## 0. Decide first

1. **GitHub organization:** if the repos are moving into one, do it now, together with Vercel Pro
   (Hobby can't deploy private repositories owned by an organization). Otherwise stay on the
   personal account.
2. **Render plan:** **Starter** (about $7 a month) at least. The free plan sleeps after 15 minutes,
   so the first question after a break waits about a minute. It also has 512 MB, too little for
   the maths and PDF workers.
3. **Clerk:** the **development instance** works, but shows a "Development mode" badge and isn't
   meant for real users. A **production instance** needs DNS records in Wix, and accounts don't
   carry over from development, so decide before real users sign up.
4. **Who never runs out:** the emails for `NEB_UNLIMITED_EMAILS` (the team, testers,
   influencers).

## 1. Pass the preview tests

Don't merge to `main` until the journey passes on the preview ([LAUNCH_TESTING.md](LAUNCH_TESTING.md)):

- the automated journey against the preview;
- the Windows checklist with the desktop app pointed at the preview.

## 2. Upstash (production)

1. [console.upstash.com](https://console.upstash.com) → **Create database** → Redis.
   - **Name:** `neb-prod`
   - **Region:** US East, near Vercel's `iad1`
   - **Plan:** free
2. From **REST API**, copy the two values into `.env.production-values`:

   ```
   UPSTASH_REDIS_REST_URL=…
   UPSTASH_REDIS_REST_TOKEN=…
   ```

## 3. Production database

The production database has every migration up to `concept_nodes`. Some of those were run by
hand in the SQL editor, so Supabase's migration history isn't reliable. Check by what exists
instead.

1. In the **production** project's SQL editor (`gvwynloprjomqqovpoem`), run:

   ```sql
   select
     to_regclass('public.skills')               is not null as "20261108 skills",
     exists (select 1 from information_schema.columns
             where table_name = 'moment_checks' and column_name = 'origin')
                                                 as "20261109 screen_quiz",
     to_regclass('public.handwriting_samples')  is not null as "20261110 handwriting",
     exists (select 1 from information_schema.columns
             where table_name = 'moment_checks' and column_name = 'stayed_at')
                                                 as "20261111 stayed",
     to_regclass('public.question_quota')       is not null as "20261112 question_quota",
     exists (select 1 from information_schema.columns
             where table_name = 'question_quota' and column_name = 'notify_when_more')
                                                 as "20261113 quota_notify",
     not has_function_privilege('anon', 'public.reserve_question(text,text,integer,boolean,boolean)',
                                 'execute')      as "20261114 quota_functions_server_only";
   ```

   **Status, 2026-11-14:** production has all of these. 20261112–20261114 were applied that day,
   after the database was restored from a pause. The test database
   (`qnhfzevygmlgfrbavswq`) still needs 20261114.

   Production also has three tables from Rahbir's unmerged
   `feature/stripe-payment-integration` branch (`subscriptions`, `usage_sessions`,
   `stripe_events`). Its migration file is also numbered `20261112000000`, so renumber it after
   `20261114000000` when that branch merges.

2. Every `false` is a migration to apply. Run those files from `backend/supabase/migrations`
   **in filename order**, in one query wrapped in `begin;` … `commit;`, so a failure applies
   nothing. Claude can build that file once you send the result.
3. Run the query again: everything should be `true`.

**Clerk:** if you're switching to a Clerk production instance, also go to **Authentication →
Third-party auth** on the production project and update the Clerk domain to the production one,
for example `https://clerk.myneb.si`.

## 4. Clerk

**Staying on the development instance:**

1. Clerk dashboard → **Domains** (or Paths, or Allowed origins): allow `https://app.myneb.si`.
2. **Webhooks → Add endpoint**:
   - **URL:** `https://app.myneb.si/api/webhooks/clerk`
   - **Events:** `user.created`, `user.updated`, `user.deleted`
   - Copy its **Signing secret** into `.env.production-values` as `CLERK_WEBHOOK_SECRET=…`.

**Switching to a production instance**, in addition:

1. In Clerk, **create the production instance** for `myneb.si`. Clerk shows several DNS records
   (CNAMEs such as `clerk`, `accounts` and email ones). Add each one in **Wix → Domains →
   myneb.si → DNS records**, then wait until Clerk shows them verified.
2. **Turn on the same sign-in methods** as in development (Google, email), and **bot
   protection**.
3. **Copy the production keys** into `.env.production-values`:
   - `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` (`pk_live_…`)
   - `CLERK_SECRET_KEY` (`sk_live_…`)
   - `CLERK_ISSUER`: the production Frontend API URL, for example `https://clerk.myneb.si`
4. **Then do the webhook step above** on the production instance.

## 5. Backend on Render (production)

1. Render → **New → Web Service** → the `mew` repo:
   - **Name:** `neb-api`
   - **Branch:** `main`
   - **Root directory:** `backend`
   - **Runtime:** Docker
   - **Plan:** Starter, or bigger
   - **Health check path:** `/health`, all lowercase
2. **Environment** (paste with **Add from .env**):

   | Variable                               | Value                                                                                                                          |
   | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
   | `APP_ENV`                              | `production`                                                                                                                   |
   | `INTERNAL_API_SECRET`                  | **new**, from `python -c "import secrets; print(secrets.token_urlsafe(48))"`. Also goes in `.env.production-values` for Vercel |
   | `CLERK_ISSUER`                         | the development or production Frontend API URL (step 4)                                                                        |
   | `CLERK_AUTHORIZED_PARTIES`             | `https://app.myneb.si`                                                                                                         |
   | `ALLOWED_HOSTS`                        | `localhost` (Render's own host is trusted automatically)                                                                       |
   | `NEXT_PUBLIC_SUPABASE_URL`             | `https://gvwynloprjomqqovpoem.supabase.co`                                                                                     |
   | `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | production publishable key                                                                                                     |
   | `SUPABASE_SECRET_KEY`                  | production secret key                                                                                                          |
   | `GEMINI_API_KEY`                       | the real key (course ingestion, OCR, lessons)                                                                                  |

| `GEMINI_TUTOR_MODEL` | `gemini-3.5-flash-lite`, the same model the web app uses. The code default (`gemini-3.8-flash`) timed out on this key, and courses then fell back to raw headings |
| `FREE_QUESTION_LIMIT` | `8` |

3. When it's **Live**, `https://<service>.onrender.com/health` answers OK. Put that address in
   `.env.production-values` as `API_BASE_URL=…`.

## 6. The app on Vercel (production)

1. **Settings → Environment Variables**, scope **Production**:

   | Variable                                                                                  | Value                                                         |
   | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
   | `APP_ORIGIN`                                                                              | `https://app.myneb.si`                                        |
   | `API_BASE_URL`                                                                            | the Render address from step 5                                |
   | `INTERNAL_API_SECRET`                                                                     | the same new value as on Render                               |
   | `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`                                   | the instance from step 4                                      |
   | `NEXT_PUBLIC_CLERK_SIGN_IN_URL`, `NEXT_PUBLIC_CLERK_SIGN_UP_URL`                          | `/sign-in`, `/sign-up`                                        |
   | `CLERK_WEBHOOK_SECRET`                                                                    | from step 4                                                   |
   | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY` | production                                                    |
   | `GEMINI_API_KEY`, `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`                             | the real ones (model ids are optional; the code has defaults) |
   | `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`                                      | production, from step 2                                       |
   | `FREE_QUESTION_LIMIT`                                                                     | `8`                                                           |
   | `GLOBAL_DAILY_QUESTION_CAP`                                                               | `2000` (everyone together, per UTC day)                       |
   | `GLOBAL_DAILY_USD_CAP`                                                                    | `20` (stops asking past about $20 of AI a day)                |
   | `NEB_UNLIMITED_EMAILS`                                                                    | comma-separated emails from step 0                            |
   | `NEB_ASK_ENABLED`                                                                         | **`false`** for now                                           |
   - **Don't set:** `NEB_FAKE_MODEL`, `ASK_PER_MINUTE`, `ASK_PER_HOUR` or `ASK_IP_PER_MINUTE`.
     Production uses the real limits.
   - **Check** that none of the test copy's values (staging Supabase, staging Upstash) are scoped
     to Production.

2. **Merge** `feat/launch-limits` into `main` with a pull request on GitHub. Vercel builds
   Production, and Render builds `neb-api`. Wait until both are **Ready** / **Live**.
3. **Domain:** `neb-app` → **Settings → Domains → Add** → `app.myneb.si`. Vercel shows the record
   it needs, normally a **CNAME** `app` → `cname.vercel-dns.com`.
4. **Wix → Domains → myneb.si → DNS records → Add record:** type CNAME, host `app`, value as
   Vercel says. It's usually live within an hour. Vercel issues the certificate itself, and the
   domain shows **Valid Configuration** when done.

## 7. Smoke test, then switch asking on

1. **The backend:** `https://<render service>/health` answers `{"status":"ok"…}`.
2. **The app:** `https://app.myneb.si` loads.
3. **Sign-up first:** in a private window, `https://app.myneb.si/desktop/authorize?challenge=x`
   goes to **sign-up**.
4. **A real account:** sign up with a real email, and the desk shows "8 of 8 questions left".
5. **Switch asking on:** set `NEB_ASK_ENABLED=true` on Vercel Production → **Redeploy**.
6. **One real question:** ask one in the notebook. It answers out loud, and shows "7 of 8 left".
   - In the Render logs: no errors.
   - In the Vercel logs: no 5xx.
7. **The previews:** turn the login wall back on, with `vercel project protection enable neb-app
--sso` or under Settings → Deployment Protection.

## 8. The Windows installer

Built on a Windows PC from `main` ([DESKTOP_RELEASE.md](DESKTOP_RELEASE.md)):

```powershell
$env:MEW_APP_URL = "https://app.myneb.si"
pnpm --filter @mew/desktop bundle:release
# → desktop\src-tauri\target\release\bundle\nsis\Neb_<version>_x64-setup.exe
```

- **Test it on a clean PC:** install, sign up, Continue, ask one question.
- **Tell everyone you send it to** about the SmartScreen warning (**More info → Run anyway**). It
  goes away only with a code-signing certificate.
- **Auto-update:** not set up yet (the updater key is empty), so a fix means sending a new
  installer. To set it up, see DESKTOP_RELEASE.md's signing key steps.

## 9. Watch it

- **Vercel → `neb-app` → Logs,** and **Render → `neb-api` → Logs.**
- **Upstash:** the daily counters.
- **Supabase:** in `question_log`, how many questions a day, and refunds.
- **Costs:** Google AI Studio (Gemini) and ElevenLabs usage pages.

## If something goes wrong

| Problem                  | Do this                                                                          |
| ------------------------ | -------------------------------------------------------------------------------- |
| AI costs or abuse        | Vercel: `NEB_ASK_ENABLED=false` → Redeploy. All AI stops; notebooks keep working |
| A bad web deploy         | Vercel → Deployments → the last good one → **Instant Rollback**                  |
| A bad backend deploy     | Render → `neb-api` → Deploys → **Rollback**                                      |
| Too many questions a day | Lower `GLOBAL_DAILY_QUESTION_CAP` or `GLOBAL_DAILY_USD_CAP` → Redeploy           |

## Launch day (the website only)

Everything above is already live. On the day:

1. **`neb_web`:** merge the launch branch (with `review/launch-mode`) into `main`.
2. **`neb-web` → Production:** set `LAUNCH_MODE=open` and
   `NEXT_PUBLIC_APP_URL=https://app.myneb.si` → Redeploy.
3. **The installer:** put it where `/download` points.
4. **Check:**
   - "Get neb" → `/download` → the installer.
   - "Email me the link" arrives.
   - "Already have an account? Sign in" goes to app.myneb.si.
5. **To close the door again:** `LAUNCH_MODE=waitlist` → Redeploy.
