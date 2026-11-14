# Setting up the preview

How to host a test copy of the launch work, so the journey test, k6, the database race and the
Windows checklist ([LAUNCH_TESTING.md](LAUNCH_TESTING.md)) can run against real services. **Nothing
here touches production.** Production stays as it is until launch day.

## What you host

| Piece              | Where                          | Built from                        | Cost          |
| ------------------ | ------------------------------ | --------------------------------- | ------------- |
| Test database      | a new Supabase project         | the 29 migrations                 | free tier     |
| Test Redis         | a new Upstash database         | nothing to build                  | free tier     |
| Test API (FastAPI) | a new Render web service       | `mew`, `feat/launch-limits`       | free tier     |
| The app (Next.js)  | a Vercel project, preview only | `mew`, `feat/launch-limits`       | free (Hobby)  |
| The website        | the existing `neb_web` project | `neb_web`, `review/launch-mode`   | already there |
| The desktop app    | your Windows PC                | built locally, pointed at preview | nothing       |

Gemini and ElevenLabs aren't needed: the preview runs the fake model.

Do the steps in order: each needs a value from the one before.

## 0. Push the branch

Vercel and Render build from GitHub. In `mew`:

```sh
git add -A
git commit -m "feat: launch round 2"
git push
```

## 1. Test database (Supabase)

1. [supabase.com](https://supabase.com/dashboard) → **New project**. Name it `neb-staging`, in the
   same region as production, and save the database password somewhere safe.
2. **Apply the migrations.** Use one of these two ways:
   - **SQL editor (simplest):** open **SQL Editor → New query**, paste all of
     `neb_staging_all_migrations.sql` (all 29 migrations, in order, in one transaction) and
     **Run**. If it fails, nothing is applied: send the error.
   - **CLI:** in `mew/backend`, run `npx supabase link --project-ref <staging-ref>` then
     `npx supabase db push`.
   - Either way, check that the ref is the staging project's. Never use `gvwynloprjomqqovpoem`,
     which is production.
   - **Check:** under **Table Editor** you should see `question_quota`, `device_quota`,
     `question_log` and `device_tokens`.
3. **Clerk:** go to **Authentication → Sign In / Providers → Third-party auth → Add provider →
   Clerk**. The domain is the same as production's: `still-mosquito-3338.clerk.accounts.dev`.
4. **Keys:** from **Project Settings → API Keys**, copy:
   - the project URL (`https://<staging-ref>.supabase.co`);
   - the **publishable** key (`sb_publishable_…`);
   - the **secret** key (`sb_secret_…`). Keep it secret.

## 2. Test Redis (Upstash)

[console.upstash.com](https://console.upstash.com) → **Create database** → Redis, named
`neb-staging`, the free plan, a region close to Vercel's (US East). From **REST API**, copy
`UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`.

## 3. A shared secret

Make one random value for the app and the API to share:

```sh
python -c "import secrets; print(secrets.token_urlsafe(48))"
```

This is `INTERNAL_API_SECRET` in steps 4 and 5. It should be a different value from production's.

## 4. Test API (Render)

1. [dashboard.render.com](https://dashboard.render.com) → **New → Web Service** → the `mew` repo.
   - **Name:** `mew-api-staging`
   - **Branch:** `feat/launch-limits`
   - **Root directory:** `backend`
   - **Runtime:** Docker (it finds `backend/Dockerfile`)
   - **Health check path:** `/health`
   - **Plan:** Free
2. Set the **environment variables**:

   | Variable                               | Value                                                          |
   | -------------------------------------- | -------------------------------------------------------------- |
   | `APP_ENV`                              | `production`                                                   |
   | `INTERNAL_API_SECRET`                  | from step 3                                                    |
   | `CLERK_ISSUER`                         | `https://still-mosquito-3338.clerk.accounts.dev`               |
   | `CLERK_AUTHORIZED_PARTIES`             | `https://placeholder.example` for now; you set it after step 5 |
   | `ALLOWED_HOSTS`                        | `localhost`                                                    |
   | `NEXT_PUBLIC_SUPABASE_URL`             | staging, from step 1                                           |
   | `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | staging, from step 1                                           |
   | `SUPABASE_SECRET_KEY`                  | staging, from step 1                                           |
   | `FREE_QUESTION_LIMIT`                  | `8`                                                            |

3. Deploy. When it's live, `https://mew-api-staging.onrender.com/health` should answer OK.
4. The free plan sleeps after 15 minutes idle, and the first request after that takes up to a
   minute. Open `/health` before each test session.

## 5. The app (Vercel, preview only)

There's no Vercel project for the app yet. This creates one, but **don't add app.myneb.si**:
that's for launch day.

1. [vercel.com/new](https://vercel.com/new) → import the `mew` repo.
   - **Root Directory:** `frontend`. Leave "Include files outside the root directory" on: the
     app uses `packages/shared`.
   - **Framework:** Next.js (detected). Leave the build and install commands as they are: pnpm is
     read from the repo.
2. Before the first deploy, open **Environment Variables**. Add each of these for **Preview**
   only, and set the branch to `feat/launch-limits`:

   | Variable                                              | Value                                                     |
   | ----------------------------------------------------- | --------------------------------------------------------- |
   | `NEB_FAKE_MODEL`                                      | `1`                                                       |
   | `GEMINI_API_KEY`                                      | `fake-model`                                              |
   | `ELEVENLABS_API_KEY`                                  | `fake-model`                                              |
   | `API_BASE_URL`                                        | `https://mew-api-staging.onrender.com`                    |
   | `INTERNAL_API_SECRET`                                 | from step 3                                               |
   | `APP_ORIGIN`                                          | the branch address (below); add it after the first deploy |
   | `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`                   | the Clerk development key (`pk_test_…`)                   |
   | `CLERK_SECRET_KEY`                                    | the Clerk development key (`sk_test_…`)                   |
   | `NEXT_PUBLIC_CLERK_SIGN_IN_URL`                       | `/sign-in`                                                |
   | `NEXT_PUBLIC_CLERK_SIGN_UP_URL`                       | `/sign-up`                                                |
   | `NEXT_PUBLIC_SUPABASE_URL`                            | staging                                                   |
   | `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`                | staging                                                   |
   | `SUPABASE_SECRET_KEY`                                 | staging                                                   |
   | `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`  | from step 2                                               |
   | `NEB_QUOTA`                                           | `on`                                                      |
   | `FREE_QUESTION_LIMIT`                                 | `8`                                                       |
   | `ASK_PER_MINUTE`, `ASK_PER_HOUR`, `ASK_IP_PER_MINUTE` | `1000` (journey only; remove before k6)                   |
   - Don't add `NEB_UNLIMITED_EMAILS`.
   - Don't add anything for **Production**. A `main` deploy without these variables fails or
     shows nothing, and that's fine for now.

3. **Deploy:** push to `feat/launch-limits`, or use **Deployments → Redeploy**. Open the
   deployment and copy the **branch address**:
   `https://<project>-git-feat-launch-limits-<team>.vercel.app`. It stays the same on every deploy
   of the branch, so use it everywhere below.
4. Set `APP_ORIGIN` on Vercel to that address, then redeploy.
5. Set `CLERK_AUTHORIZED_PARTIES` on Render to that address, then redeploy Render.
6. **Settings → Deployment Protection:** turn **Vercel Authentication** off while you test.
   Otherwise the desktop app and the test scripts get Vercel's login page. Turn it back on
   afterwards.
7. **Check:**
   - The branch address opens neb.
   - `<branch address>/desktop/authorize?challenge=x` in a private window goes to **sign-up**.

## 6. The website preview (`neb_web`)

`review/launch-mode` is already pushed, so it already has a preview. In the `neb_web` Vercel project
→ Environment Variables, add these for **Preview**, branch `review/launch-mode`:

- `LAUNCH_MODE` = `open`
- `NEXT_PUBLIC_APP_URL` = the app's branch address from step 5

Redeploy that branch.

The website's waitlist and Resend keys on Preview are probably the live ones:

- "Email me the link" really sends, so send it only to your own address.
- The test row it adds to the real waitlist needs deleting afterwards. In the `neb_web` Supabase
  project, run `delete from waitlist where email = '<your email>';`.

## 7. The desktop app (on the Windows PC)

The installer on the real `/download` page connects to production, so build one that doesn't:

```powershell
pnpm --filter @mew/desktop bundle:release
# install desktop\src-tauri\target\release\bundle\nsis\*.exe
setx MEW_APP_URL "https://<app branch address>"
```

Then start neb from the Start menu. When you're done, run `setx MEW_APP_URL ""`, or neb stays on
the preview.

## 8. Run the tests

Follow [LAUNCH_TESTING.md](LAUNCH_TESTING.md) section 2 (journey, k6, race), then section 3 (Windows) and
section 4 (website).

**A device token for the journey and k6:**

1. Sign up on the branch address with a new account, in Edge.
2. Press F12 → Console, paste this and press Enter:

```js
const b64 = (a) =>
  btoa(String.fromCharCode(...new Uint8Array(a)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
const verifier = b64(crypto.getRandomValues(new Uint8Array(32)));
const challenge = b64(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
const { code } = await (
  await fetch("/api/devices/link", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ challenge }),
  })
).json();
const { token } = await (
  await fetch("/api/devices/exchange", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, verifier, deviceName: "Journey test" }),
  })
).json();
console.log(token);
```

3. It prints `mewdt_…`. That's a real sign-in for that account, so don't share it.

**Starting again:** the journey uses up the account's 8 questions and signs its token out at the
end. In the **staging** SQL editor, run:

```sql
delete from question_log; delete from question_quota; delete from device_quota;
```

Then get a new token as above.

**Before k6:** remove the three `ASK_*` variables in Vercel and redeploy, so k6 hits the real
limits.

## After testing

- Turn Vercel Deployment Protection back on.
- Keep the staging services: they're free while idle, and you'll use them again before launch.
- Don't merge either branch until the journey passes on the preview.

## Not part of the preview: launch day

Production isn't touched here. On launch day:

- **Migrations:** the production database still needs the migrations from after
  `concept_nodes`, at least `question_quota` and `quota_notify`. Check which others are missing
  first, as they were applied by hand before and aren't recorded.
- **Clerk:** allow redirects to app.myneb.si.
- **Configuration:** the production variables in [LAUNCH_LIMITS.md](LAUNCH_LIMITS.md), and the
  domain on the app's Vercel project.
