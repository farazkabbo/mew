# mew

An ambient AI tutor that lives inside your notebook. It stays quiet until it's actually needed,
then answers by voice and in animated ink on the page.

## Repository layout

```
frontend/            Next.js 16 app: the notebook UI, plus its /api routes (gate, tutor, speech)
backend/             FastAPI on Python 3.12 (internal service: checkers, ingestion, heavy LLM work)
backend/supabase/    Postgres migrations (RLS) and their tests (run against PGlite, no Docker needed)
packages/shared/     Shared zod schemas, prompts and types (mirrored by Pydantic models in backend/)
packages/ink/        Framework-free ink logic: geometry, spatial index, line segmentation, undo/redo
scripts/             Dev tooling (`pnpm health`)
```

### How the pieces talk

```
browser ──(Clerk session cookie)──► Next.js server ──(X-Internal-Secret + Clerk JWT)──► FastAPI
   │                                     │
   └──(Clerk JWT, RLS-enforced)──────────┴──────────────────────────────────────────► Supabase
```

- **Clerk** owns identity. Supabase trusts Clerk tokens via
  [third-party auth](https://supabase.com/docs/guides/auth/third-party/clerk). The user id is the
  token's `sub` claim (`user_…`, a text column).
- **FastAPI is never called from the browser.** Only the Next.js server calls it, with a shared
  secret plus the user's Clerk token, which FastAPI verifies against Clerk's JWKS.
- **Supabase is reached with the user's own token**, so row-level security applies to every query.
  The secret key (which bypasses RLS) is reserved for narrowly scoped server jobs.

## Prerequisites

- Node.js ≥ 22 and pnpm 12 (`npm i -g pnpm`)
- [uv](https://docs.astral.sh/uv/) (installs Python 3.12 for the API automatically)

## Setup

```sh
pnpm install
cd backend && uv sync && cd ..
cp .env.example .env.local   # then fill it in (see below)
```

`.env.local` at the repo root is read by both the web app and the API. It is gitignored.

### Local mode (no Clerk keys)

Without `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, the dev server runs in **local mode**: no sign-in,
notebooks saved only in this browser, and the same strict CSP. Production refuses to serve
(HTTP 503) without Clerk keys, so local mode can't become an auth bypass.

### Clerk

1. Sign the CLI in to your Clerk account, link the app, and pull its dev keys into `frontend/.env.local`:
   ```sh
   cd frontend
   npx clerk@latest auth login
   npx clerk@latest link --app <your-app-id>
   npx clerk@latest env pull
   ```
   Or copy `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY` from the dashboard
   (API keys) into the root `.env.local`.
2. Set `CLERK_ISSUER` to your **Frontend API URL** (dashboard → API keys), e.g.
   `https://your-app.clerk.accounts.dev`.
3. Open [Connect with Supabase](https://dashboard.clerk.com/setup/supabase) in the Clerk dashboard.
   This adds the `role: authenticated` claim that Supabase needs.

### Supabase

1. In the Supabase dashboard: **Authentication → Third-party auth → Add Clerk**, using your Clerk
   domain.
2. Apply the migrations, either with the CLI:
   ```sh
   cd backend
   npx supabase@latest login
   npx supabase@latest link --project-ref <project-ref>
   npx supabase@latest db push
   ```
   or by pasting `backend/supabase/migrations/*.sql` into the SQL editor, in filename order.
3. Put the project URL and the **publishable** key in `.env.local`. Never put the secret key in a
   `NEXT_PUBLIC_` variable; the app refuses to start if you do.

## Develop

```sh
pnpm dev       # web on :3000, API on :8000
pnpm health    # checks both services (and web → API connectivity)
```

When signed in, open [/status](http://localhost:3000/status). It runs end-to-end checks of the
auth chain (Clerk → FastAPI, Clerk → Supabase RLS) and says what to fix when one fails.

## The notebook

Open [/notebook](http://localhost:3000/notebook). Strokes are vectors stored locally in IndexedDB
(one database per user) and validated whenever they're read back.

| Action                     | How                                                                                     |
| -------------------------- | --------------------------------------------------------------------------------------- |
| Pen / highlighter / eraser | `P` / `H` / `E`, or the toolbar                                                         |
| Undo / redo                | `Ctrl+Z` / `Ctrl+Shift+Z` (or `Ctrl+Y`)                                                 |
| Zoom                       | `Ctrl`+wheel, trackpad pinch, two-finger pinch, `+` / `-`, `0` to reset                 |
| Pan                        | Wheel / two-finger scroll, `Space`+drag, middle mouse, or one finger once a pen is used |
| Show detected lines        | Toolbar (debug overlay for line segmentation)                                           |
| Export current line        | Toolbar → downloads the PNG crop that will be sent for recognition                      |

Pen pressure comes from the Pointer Events API (Apple Pencil, Wacom, Surface Pen). Mouse and
finger input get simulated pressure. Once a pen has been used, touches only navigate (basic palm
rejection).

## Voice and Mew (the gate)

Tap the **microphone** (bottom right) to start listening. Audio streams from the browser straight
to ElevenLabs Scribe, using a single-use token minted by `/api/stt/token`; the API key never
leaves the server. When you stop talking for 0.7 s, the utterance goes to **Mew**, which decides
whether the tutor should respond:

- Obvious filler ("hmm", "okay so") is ignored locally, without a model call.
- Everything else goes to `/api/mew` → Gemini Flash-Lite (minimal thinking, JSON schema
  output, `store: false`). On any failure Mew stays silent, unless you summoned it.
- Triggers: a finished utterance, "Hey Mew …", tapping the mascot, or a 1.5 s pause after writing
  a few strokes. For 4 s after the tutor speaks, only new questions get through.
- Requests are same-origin only, size-capped, schema-validated and rate-limited per user.

The **debug panel** (bug icon) shows the live transcript, every Mew decision (label,
confidence, source, round-trip time) and a sensitivity slider. It also lets you type an utterance
to test the gate without a microphone.

`pnpm eval:mew` runs 32 labelled utterances, including the M2 acceptance phrases, against the
real gate model and reports accuracy and latency. It needs `GEMINI_API_KEY`.

## The tutor

When Mew decides to respond, the **tutor** (`/api/tutor`, Gemini Flash) gets the conversation, a
PNG of your three most recent lines, and any recognised text for them. It replies with
`{ speech, actions }`:

- `speech` is streamed out of the JSON as soon as it's complete and spoken right away
  (`/api/tts` proxies ElevenLabs Flash as raw PCM, played gaplessly with Web Audio). Board
  `actions` arrive after and are drawn as ink from M4.
- **Barge-in:** speaking over the tutor, or touching the page with the pen, fades it out within
  150 ms. The tutor's own voice picked up by the mic doesn't count: transcripts that mostly repeat
  what it's saying are treated as echo.
- If the model returns invalid output it's retried once, then the turn falls back to speech only.
  The caption bubble (togglable) shows what the tutor says.
- After a writing pause, the current line is recognised in the background (`/api/recognize`,
  cached per exact strokes). Mew uses the text as `activeRegionText`.
- Images sent to the server must be real PNGs (signature and size are checked). Text-to-speech is
  budgeted per character per user.

`pnpm eval:tutor` measures time-to-first-audio for real turns (needs the Gemini and ElevenLabs
keys plus `ELEVENLABS_VOICE_ID`) and fails if the median is over 2 s.

## Quality gates

```sh
pnpm check                     # prettier, ESLint, tsc, vitest across the TS workspaces + API
pnpm --filter @mew/frontend e2e  # Playwright: drawing, persistence, eraser/undo, export, 60 fps
pnpm --filter @mew/backend audit:py  # pip-audit of the API's runtime dependencies
pnpm audit --prod              # npm advisories
```

The database tests in `backend/supabase/tests` apply every migration to an in-memory Postgres (PGlite)
that emulates Supabase's roles and `auth.jwt()`. They then attack the policies: cross-user reads
and writes, ownership spoofing, attaching rows to someone else's notebook, anon access, and
column-level tampering.

CI (`.github/workflows/ci.yml`) runs all of the above plus a production build and a gitleaks
secret scan. Actions are pinned to commit SHAs, and Dependabot keeps them and all dependencies
current.

## Deploy

- **API → Render.** `render.yaml` defines a Docker web service (`backend/Dockerfile`,
  non-root, health check `/health`). Apply it as a Blueprint, then set `INTERNAL_API_SECRET`
  (same value as the web app), `CLERK_ISSUER` and `CLERK_AUTHORIZED_PARTIES` (your web origin).
  The service refuses to boot in production without them.
- **Web.** Set every variable from the Web section of `.env.example`, with `APP_ORIGIN` set to the
  public origin and `API_BASE_URL` set to the Render service URL.

## Security notes

- Strict, nonce-based Content-Security-Policy on every page (`src/proxy.ts`), plus HSTS,
  `X-Frame-Options: DENY`, `nosniff`, and a Permissions-Policy that allows the microphone only
  for this origin.
- Clerk `authorizedParties` is pinned to `APP_ORIGIN`. FastAPI checks `iss`, `exp`/`nbf`, `azp`,
  RS256 only, and throttles JWKS refetches.
- Env vars are validated with zod (web) and Pydantic (API). Errors name variables, never values.
- FastAPI hides `/docs` and the OpenAPI schema outside development, rejects unknown `Host`
  headers, and sends no CORS headers (browsers can't call it).
