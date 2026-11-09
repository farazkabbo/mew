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

**Not built:** the polling fallback and the typed 6-character code for sign-in (the "Copy the
link" fallback exists); moving work to background jobs (the app sends no email, and PDF export
already runs on the device); a model mock for load tests (`loadtest/limits.k6.js` loads only the
gate's free paths: allowance reads and used-up accounts).

## Tests

PGlite (`question-quota.test.ts`): 8 of 20, device limit, refund once, finish, unlimited, RLS.
pytest (`test_quota.py`): 20 threads → 8. Vitest: the gate (`question-gate.test.ts`: codes,
`Retry-After`, cap and kill switch charge nobody, follow-ups and their cap, unverified, refund,
Redis down), the webhook (`route.test.ts`: signatures, replays), the answer cache. Rust: limit
messages, device id.

## By hand, on Windows (before launch)

1. Fresh install → Sign in → browser (already signed in) → one click → app shows the account.
2. Ask: the desk says 7 of 8. A circle follow-up and walkthrough steps don't change it.
3. Turn Wi-Fi off mid-answer: the count comes back.
4. Use all 8: the 0 message; the notebook, Replay and PDF still work.
5. Reinstall, and a second account on the same computer: still 0 left.
6. Settings → Signed-in devices → Sign out: the next ask is signed out.

## Pre-launch checklist

- [ ] Apply the migration to the hosted Supabase project (after a look; `20261112000000`).
- [ ] Vercel project for `frontend` at app.myneb.si; every variable in `.env.example`, including
      `UPSTASH_*`, `CLERK_WEBHOOK_SECRET`, the caps, `NEB_UNLIMITED_EMAILS`.
- [ ] Clerk production instance: keys set, bot protection on, app.myneb.si and myneb.si/download
      as allowed redirects, webhooks to both sites, and Supabase third-party auth trusting it.
- [ ] `MEW_APP_URL` and the release build pointing at app.myneb.si; signed installer on
      myneb.si/download; `neb://` registered by the installer.
- [ ] `pnpm scan:secrets` clean on the release build; rotate the OmniRoute key from chat.
- [ ] RLS checked on the hosted project; the load test run on staging; the kill switch tried.
- [ ] `LAUNCH_MODE=open` on myneb.si only on the day.
