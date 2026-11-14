# Soft launch: what's done and what's left

A handover for finishing the production setup. The app is **live at https://app.myneb.si** with
asking (all AI) **switched on** (2026-11-14). The website, myneb.si, is untouched and stays on the waitlist
until launch day.

The full background is in [PRODUCTION_SETUP.md](PRODUCTION_SETUP.md), and how it all fits
together is in [ARCHITECTURE.md](ARCHITECTURE.md).

## What's live (2026-11-14)

| Piece     | Where                                                              | State                                                               |
| --------- | ------------------------------------------------------------------ | ------------------------------------------------------------------- |
| Web app   | Vercel project `neb-app` → **https://app.myneb.si**                | Live from `main` (commit `d9f08ff`). Certificate OK                 |
| Backend   | Render service `neb-api` → https://neb-api.onrender.com            | Live from `main`, Ohio, $7 instance, health check `/health`         |
| Database  | Supabase `gvwynloprjomqqovpoem` (free plan)                        | All migrations through `20261114000000` applied and checked         |
| Limits    | Upstash `neb-prod`                                                 | Connected, empty                                                    |
| Sign-in   | Clerk, **development** instance                                    | The webhook to `https://app.myneb.si/api/webhooks/clerk` is created |
| DNS       | Wix (`myneb.si` account: kabbofaraz@gmail.com)                     | `app` CNAME → Vercel. `myneb.si` and `www` untouched                |
| Website   | Vercel project `neb-web` → myneb.si                                | **Unchanged.** Waitlist                                             |
| Test copy | `neb-app` preview + Render `mew` + Supabase `qnhfzevygmlgfrbavswq` | Still running, fake model                                           |

**Checked on the live app:**

- Signed out, the connect page goes to **sign-up**.
- app.myneb.si → `neb-api` → the database answers.
- The production shared secret is accepted; a wrong one is refused.
- The quota functions refuse the public key ("permission denied").

## Who can do what

Vercel's and Render's free plans are **single-user**, so only the owner's logins can change
`neb-app`, `neb-api` and their settings. The steps below say who:

- **Owner:** anything in Vercel, Render, Clerk, Wix or ElevenLabs.
- **Developer:** anything in the repo, plus testing.

If you need your own access, the owner either shares their screen, or upgrades the team plan:
Vercel Pro or Render Pro.

The secret files (`.env.local`, `.env.production-values`, `.env.render-production`) exist only
on the owner's PC and are git-ignored. **Never ask for them in chat or commit them.**

## The remaining steps, in order

### 1. Sign up on the live app (owner or developer)

Open **https://app.myneb.si** in a private window and sign up with a real email.

- **Expect:** the desk shows **"8 of 8 questions left"**.
- **If it fails:** check Vercel → `neb-app` → **Logs**, and Render → `neb-api` → **Logs**.

### 2. Switch asking on (owner): done 2026-11-14

1. Vercel → `neb-app` → **Settings → Environment Variables** → `NEB_ASK_ENABLED` (Production)
   → **Edit** → `true` → **Save**.
2. **Deployments** → the newest **Production** deployment → **⋯ → Redeploy**. This also
   activates `CLERK_WEBHOOK_SECRET`, which was added after the last build.

### 3. First real question (owner or developer)

On app.myneb.si, open a notebook and ask something out loud.

- **Expect:** a real AI answer, **spoken**, and the desk showing **7 of 8 left**.
- **If there's no voice:** check the ElevenLabs plan (step 7).
- **If there's no answer:** check the Vercel logs for `/api/tutor`.
- **To switch all AI off at once:** set `NEB_ASK_ENABLED=false` → Redeploy.

### 4. Build the Windows installer (developer, on a Windows PC)

From an up-to-date `main` ([DESKTOP_RELEASE.md](DESKTOP_RELEASE.md)):

```powershell
git checkout main; git pull
pnpm install
$env:MEW_APP_URL = "https://app.myneb.si"
pnpm --filter @mew/desktop bundle:release
# → desktop\src-tauri\target\release\bundle\nsis\Neb_<version>_x64-setup.exe
```

**`MEW_APP_URL` must be set,** or the app opens `localhost:3000`.

Test the installer on a PC **without** a development build of neb:

1. **Install:** Windows shows "Windows protected your PC" → **More info → Run anyway**. Expected
   until the installer is code-signed.
2. **Sign in:** open neb → **Sign in** → the browser shows **sign-up** → sign up →
   "Connect neb on a Windows PC, started just now?" → **Continue** → allow Edge to open neb.
   neb greets you.
3. **Ask:** hold **Ctrl+Alt**, circle something on screen and ask. You get a real answer with
   drawing, and the count drops by one.
4. **Polling:** sign out of neb and sign in again, but click **Cancel** on Edge's "Open neb?".
   It still connects within about 2 seconds.
5. **Cancelling:** start a sign-in and click **This wasn't me**. neb says it was cancelled.

Hand the `.exe` to the owner. Testers and the influencer need the "Run anyway" note.

**Auto-update isn't set up** (the updater key is empty), so a fix means a new installer.

### 5. Turn the preview login wall back on (owner)

It was turned off for testing the preview. Do either:

- Vercel → `neb-app` → **Settings → Deployment Protection** → **Vercel Authentication** on; or
- `vercel project protection enable neb-app --sso`

### 6. Delete the leftover secrets file (owner)

Render has the values now. On the owner's PC, delete `.env.render-production` from the repo root.

### 7. Check the ElevenLabs plan (owner)

- **The free plan** (10,000 credits a month) lasts only about **30 spoken answers**.
- **For about 40 users** using all 8 questions, the **Creator plan (~$22/month)** is about right.
- **Estimated cost per user** is about $0.15–0.30, almost all of it voice. See the cost note at
  the end.

### 8. Fix Rahbir's billing functions (Rahbir, with the owner)

Production has tables and functions from the unmerged `feature/stripe-payment-integration` branch.
Supabase's security checker flags two problems in it:

- `get_or_create_usage_session` and `is_premium_user` are **security definer** functions
  callable with the **public key** (`anon`), with no fixed `search_path`. Anyone can create usage
  sessions for any user, or check whether any user is premium.
- **The fix:** in the billing migration and on production, add `set search_path = ''`, then
  `revoke execute on function … from anon, authenticated` (keep `service_role`), unless the
  browser really needs one of them. See how
  [20261114000000_quota_functions_server_only.sql](../backend/supabase/migrations/20261114000000_quota_functions_server_only.sql)
  did it.
- **Renumber** his `20261112000000_billing.sql` to after `20261114000000` (it clashes with
  `…_question_quota.sql`) before merging.

**Why:** Supabase grants every new function in `public` to `anon` and `authenticated` by name,
so `revoke … from public` alone isn't enough. The test database (`backend/supabase/tests/harness.ts`)
now copies this, so a missing revoke fails the tests.

### 9. Unlimited testers (owner)

Once the team agrees on the list:

1. Vercel → `neb-app` → Environment Variables → Production → **add**
   `NEB_UNLIMITED_EMAILS=a@x.com,b@y.com`, with no quotes and no spaces.
2. **Redeploy.**

### 10. The test database (owner, or Rahbir with access)

The test Supabase project `qnhfzevygmlgfrbavswq` is in a separate Supabase account. It still needs
the permission fix. Run in its SQL editor:

```sql
revoke execute on function public.reserve_question(text, text, integer, boolean, boolean) from anon, authenticated;
revoke execute on function public.refund_question(uuid) from anon, authenticated;
revoke execute on function public.finish_question(uuid, text, integer, integer) from anon, authenticated;
revoke execute on function public.ask_to_notify(text, integer) from anon, authenticated;
```

## Good to know

- **Supabase free plan:** the production database **pauses after about a week with no
  activity**. The app then fails until someone opens the Supabase dashboard → project →
  **Restore** (a few minutes). Supabase Pro (~$25/month) never pauses.
- **The daily caps** are on Vercel Production:
  - `GLOBAL_DAILY_QUESTION_CAP=2000`
  - `GLOBAL_DAILY_USD_CAP=20`: this counts voice at about $0.30 per 1,000 characters, so a very
    busy day (about 100+ questions) trips it. Users then see "at capacity" until midnight UTC.
    Raise it before a big push.
- **Clerk is still the development instance:** sign-in shows a "Development mode" badge, and
  the instance has a user cap. Accounts don't carry over to a production instance later.
- **The `neb-api` instance ($7, 512 MB)** is fine for questions. Upgrade it to the $25 instance
  (2 GB) in Render → Settings → Instance Type if students upload PDF courses or use maths checks
  a lot, or if Render shows memory near the limit.
- **Rollback:**
  - Vercel → Deployments → a good one → **Instant Rollback**.
  - Render → `neb-api` → Deploys → **Rollback**.

## Launch day (not now)

Only the website changes. See the end of [PRODUCTION_SETUP.md](PRODUCTION_SETUP.md):

1. Merge `neb_web`'s launch branch.
2. Set `LAUNCH_MODE=open` and `NEXT_PUBLIC_APP_URL=https://app.myneb.si` on `neb-web`
   Production.
3. Upload the installer where `/download` points.
