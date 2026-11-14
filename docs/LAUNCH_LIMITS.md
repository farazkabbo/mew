# Launch limits

Built 2026-11-09 from the launch brief, adapted to our stack. The owner's answers: the app goes
live at **app.myneb.si** (Vercel; myneb.si stays the front door, `neb_web`); a question is what
the learner asks, and at 0 every model call stops; **Upstash Redis**; and we **keep our device
tokens** (checked on every request) instead of short JWTs with refresh tokens. The API contract
is [DESKTOP_API.md](DESKTOP_API.md), copied into `neb_web`.

## What's where

| Part                                      | Where                                                                                                                                                                                                                                                                                                                   |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No key ships (desktop and browser bundle) | `scripts/scan-secrets.mjs`, a CI step after the build. Git history of both repos: no real keys.                                                                                                                                                                                                                         |
| 8 questions, per account and per computer | Migration `20261112000000_question_quota.sql`: `question_quota`, `device_quota`, `question_log`; `reserve_question`, `refund_question`, `finish_question` (service role only; a learner can read their own row). FastAPI `routes/quota.py`.                                                                             |
| The question gate                         | `frontend/src/server/question-gate.ts`: kill switch and daily cap → follow-up group (free) → verified email → Redis limits → reserve → answer → finish or refund. `limits.ts` holds every number.                                                                                                                       |
| What counts                               | `/api/screen/ask`, `/api/screen/circle-ask` (per session; 8 follow-ups free), coach start/resume/recheck (steps free, up to 40), `/api/tutor` (a turn within 5 minutes of the last continues it). 19 other model routes need questions left (`requireAllowance`). Saving clips, the notebook, Replay and PDF stay free. |
| Redis                                     | `redis.ts`: Upstash sliding windows, day counters, follow-up groups, the 7-day answer cache. Missing or down: in memory (limits stay on; Postgres still counts).                                                                                                                                                        |
| Daily cap and kill switch                 | Questions and estimated dollars per UTC day (`GLOBAL_DAILY_*`); `NEB_ASK_ENABLED=false`. 503 `AT_CAPACITY`, nobody charged.                                                                                                                                                                                             |
| Clerk                                     | `/api/webhooks/clerk` (Svix-verified): `user.created` → allowance row; `user.deleted` → every computer signed out; `user.updated` → email facts forgotten. `session.revoked` is ignored on purpose (a browser sign-out doesn't sign out the desktop). Verified email checked per learner, cached 10 minutes.            |
| Desktop                                   | `credential::device_id` (a UUID in Credential Manager), sent as `X-Neb-Device` on every request; the server's own sentence shown for the four codes.                                                                                                                                                                    |
| App                                       | "N of 8 questions left" on the desk; one notice at 2; the 0 message.                                                                                                                                                                                                                                                    |
| neb_web                                   | `LAUNCH_MODE`, Get neb, `/download`, waitlist `converted`, Upstash waitlist limit (`neb_web/docs/LAUNCH.md`).                                                                                                                                                                                                           |

**Second round (2026-11-09, the owner's decisions on the gap report):**

- Download first: "Get neb" → public `/download` (OS detected; Mac/Linux "Windows-only for now"),
  "Email me the link" (`neb_web /api/download-link`: waitlist upsert `download`/`download_mac`,
  always sends, 5/hour per address and 3/day per email, timeout + one retry), "Already have an
  account? Sign in". Sign-up happens in the app: `/desktop/authorize` shows sign-up first.
- Sign-in: `state` checked on the link; polling every 2 s for 3 minutes (`/api/devices/poll`,
  PKCE-verified); "Connect neb on a Windows PC, started just now?" with **This wasn't me**
  (cancels for good). The click stays. No 6-character code; "Copy the link" stays.
- At 0: `notify_when_more` (migration `20261113000000_quota_notify.sql`), "We'll email you at
  a•••@gmail.com…", and `scripts/export-notify-emails.mjs` (a CSV for a Resend broadcast).
- Fake model (`frontend/src/server/fake-model.ts`): `NEB_FAKE_MODEL=1` on a non-production deploy;
  `next.config.ts` refuses a production build with it.
- Journey test `pnpm --filter @mew/frontend journey` (steps 1–12; locally with live keys blanked,
  or on a preview with `JOURNEY_BASE_URL`, `JOURNEY_DEVICE_TOKEN`, `JOURNEY_SITE_URL`). Real
  Postgres race: `scripts/staging-quota-race.mjs` (refuses production).

**Still not done:** background jobs (no queue yet, as decided), the 6-character code. Steps 11
(cap and kill switch) and the device limit across accounts are unit-tested, not in the journey.

## Tests

PGlite: 8 of 20, device limit, refund, finish, unlimited, notify, RLS. pytest: 20 threads → 8,
polling, "This wasn't me". Vitest: the gate (codes, Retry-After, cap and kill switch, follow-ups,
unverified, refund, Redis down), webhook signatures, the fake model. Rust: link + state parsing,
limit messages, device id. Journey: passes locally (2026-11-09); not yet on a preview.

## On a real Windows machine (before merging)

1. Install from myneb.si/download (no account). Open neb → Sign in → the browser shows sign-up.
2. Sign up with Google → "Connect neb on a Windows PC, started just now?" → Continue → the app
   says hello within seconds, and the tab says you can close it.
3. Again, with neb:// blocked (Edge: "Always block"): polling connects within ~2 s of Continue.
4. Start a sign-in, then click **This wasn't me**: the app says it was cancelled; nothing connects.
5. Ask once: the desk says 7 of 8. A circle follow-up and walkthrough steps don't change it.
6. Wi-Fi off mid-answer: "neb had a hiccup"-style failure, and still 7.
7. Use all 8: the notice at 2, then "We'll email you at a•••@… when more open up."; the notebook,
   Replay and PDF still work.
8. Reinstall, and sign in with a second account: still 0 left on this computer.
9. Settings → Signed-in devices → Sign out: the next ask asks you to connect again.

## Pre-launch checklist

- [ ] Apply both migrations to the hosted project (after a look: `20261112000000`, `20261113000000`).
- [ ] The journey on a preview (fake model), the k6 run there, and the staging race: all pass.
- [ ] `NEB_FAKE_MODEL` unset in production (the build refuses it anyway).
- [ ] Vercel project for `frontend` at app.myneb.si; every variable in `.env.example`, including
      `UPSTASH_*`, `CLERK_WEBHOOK_SECRET`, the caps, `NEB_UNLIMITED_EMAILS`.
- [ ] Clerk production instance: keys set, bot protection on, app.myneb.si and myneb.si/download
      as allowed redirects, webhooks to both sites, and Supabase third-party auth trusting it.
- [ ] `MEW_APP_URL` and the release build pointing at app.myneb.si; signed installer on
      myneb.si/download; `neb://` registered by the installer.
- [ ] `pnpm scan:secrets` clean on the release build; rotate the OmniRoute key from chat.
- [ ] RLS checked on the hosted project; the load test run on staging; the kill switch tried.
- [ ] `LAUNCH_MODE=open` on myneb.si only on the day.
