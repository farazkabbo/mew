# How neb is built

A map for a developer joining the project: what each folder holds, how the pieces talk, and
where everything runs. For setting up your machine, use [ONBOARDING.md](../ONBOARDING.md). For
build status and past decisions, see [HANDOFF.md](HANDOFF.md).

The product is called **neb**. Its old name, **Mew**, is still all through the code: the repo,
package names (`@mew/…`) and the Python package `mew_api`. "Mew" is also the name of the gate
model that decides when the tutor speaks.

## What neb is

An AI tutor for students, in two parts:

- **The notebook** (web app): the student writes by hand and talks. The tutor stays quiet until
  it's needed, then answers out loud and writes on the page in animated ink. It checks work,
  builds a course from the student's PDF, and tracks progress with spaced review.
- **Screen Coach** (desktop app, Windows): the student holds two keys, circles anything on
  screen and asks. neb explains it, step by step, drawing on top of the screen. What's useful
  gets saved into the notebook.

## The pieces

```
                 ┌──────────────── myneb.si (separate repo: neb_web) ───────────────┐
                 │  marketing site, waitlist, /download                              │
                 └───────────────────────────────┬──────────────────────────────────┘
                                                 │ "Get neb" / "Sign in"
                                                 ▼
 ┌──────────────┐   pages + /api/*   ┌──────────────────────────────┐   X-Internal-Secret  ┌──────────────────┐
 │ Browser      │ ─────────────────► │  frontend/ (Next.js 16)      │ ───────────────────► │ backend/ (FastAPI│
 │ (notebook)   │                    │  app.myneb.si on Vercel      │                      │ on Render)       │
 └──────────────┘                    │                              │                      │ SymPy, PDFs,     │
 ┌──────────────┐  Bearer mewdt_…    │  • Clerk sign-in             │                      │ quota, devices   │
 │ desktop/     │ ─────────────────► │  • calls Gemini + ElevenLabs │                      └────────┬─────────┘
 │ (Tauri, Rust)│  (device token)    │  • question gate, limits     │                               │ secret key
 │ Screen Coach │ ◄── shows the ──── │  • Upstash Redis (limits)    │                               ▼
 └──────────────┘    web app inside  └──────────────┬───────────────┘                      ┌──────────────────┐
                                                    │ the user's own Clerk token (RLS)     │ Supabase Postgres│
                                                    └─────────────────────────────────────►│ (+ storage)      │
                                                                                           └──────────────────┘
```

**The rules that hold it together:**

- **Keys stay on servers.** The browser and the desktop app only talk to the Next.js server.
  Only Next.js holds the Gemini and ElevenLabs keys. Browsers get single-use, 15-minute speech
  tokens. A secret scan (`pnpm scan:secrets`) fails the build if a key ends up in anything that
  ships.
- **Next.js → FastAPI** uses a shared secret (`INTERNAL_API_SECRET`, sent as
  `X-Internal-Secret`). FastAPI never takes requests from users directly.
- **Supabase is reached with the signed-in user's own Clerk token,** so row-level security (RLS)
  decides what each user can read and write. The service key (`SUPABASE_SECRET_KEY`) is
  server-only and used for a few things that have no user session: desktop device tokens,
  quotas, and course ingestion.
- **Clerk** is identity. A user's id is the token's `sub` claim (`user_…`), and every table
  keys rows on it.
- **The desktop app** signs in through the browser (PKCE and a `neb://` link), then holds an
  opaque device token (`mewdt_…`). The token is stored in Windows Credential Manager and checked
  on every request. See [DESKTOP_API.md](DESKTOP_API.md).

## Folders

| Folder                                       | What it is                                                                                                                                                                    |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`frontend/`](../frontend)                   | The web app: Next.js 16, React 19, TypeScript. Pages **and** the server API (`src/app/api`). Deployed to Vercel.                                                              |
| [`backend/`](../backend)                     | FastAPI (Python 3.12, managed with `uv`). Maths checks (SymPy), PDF ingestion and lessons, notes search, the question quota, desktop devices. Deployed to Render with Docker. |
| [`backend/supabase/`](../backend/supabase)   | The database: Postgres migrations (in order, never edited once applied) and Vitest suites that attack the RLS policies.                                                       |
| [`packages/shared/`](../packages/shared)     | `@mew/shared`: zod schemas, prompts and pure logic shared by the web app, the server and tests. Shared shapes go here, so the client and server agree.                        |
| [`packages/ink/`](../packages/ink)           | `@mew/ink`: framework-free ink, covering line segmentation, undo, and the tutor's handwriting animation.                                                                      |
| [`desktop/`](../desktop)                     | The Windows app: Tauri 2 (Rust) plus small web pages for its overlays. Screen Coach lives here. See [desktop/README.md](../desktop/README.md).                                |
| [`ml/`](../ml)                               | Training "Mew v2", a small gate model run in the browser, from labelled decisions. Optional, and has heavy dependencies.                                                      |
| [`loadtest/`](../loadtest)                   | k6 load test for the question limits.                                                                                                                                         |
| [`scripts/`](../scripts)                     | Repo tools: secret scan, design tokens and glyphs, staging helpers, the notify-email export.                                                                                  |
| [`design/u/`](../design/u)                   | The UI design boards that the U series implements.                                                                                                                            |
| [`docs/`](.)                                 | Specs, decisions and guides (listed at the end).                                                                                                                              |
| [`.github/workflows/`](../.github/workflows) | CI: format, lint, types and tests on every push (Ubuntu), plus model evals.                                                                                                   |

### Inside `frontend/src`

| Path                  | What's there                                                                                                                                                                                                                        |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app/(site)/`         | Public pages: home, sign-in, sign-up, status, and the desktop finish page.                                                                                                                                                          |
| `app/(app)/`          | Signed-in pages: `desk` (home), `notebook`, `courses`, `review`, `settings`, `teach`, `desktop/authorize` (where the desktop app connects), and `dev` (UI previews).                                                                |
| `app/api/`            | The server API: tutor, voice (`stt`, `tts`), `screen/*` (the desktop app's questions), `devices/*` (desktop sign-in), notebooks, courses, quiz, quota, `webhooks/clerk`, and more.                                                  |
| `features/`           | UI by feature: `notebook`, `page` (the canvas), `tutor`, `voice`, `quiz`, `courses`, `moments`, `desk`, `desktop`, `quota`, `settings`, and so on.                                                                                  |
| `server/`             | Server-only code: `gemini.ts`, `elevenlabs.ts`, `question-gate.ts` (every AI question passes it), `limits.ts` and `rate-limit.ts`, `env.ts` (the checked environment), `csp.ts`, `fake-model.ts` (previews only), `device-auth.ts`. |
| `components/`, `lib/` | Shared UI parts and client helpers.                                                                                                                                                                                                 |
| `proxy.ts`            | Runs on every request: Clerk auth, which routes are public, and the CSP.                                                                                                                                                            |

Tests sit next to the code (`*.test.ts`, Vitest). Browser tests are in `frontend/e2e/`
(Playwright) and the launch journey in `frontend/e2e-journey/`.

### Inside `backend/src/mew_api`

| Path                          | What's there                                                                                        |
| ----------------------------- | --------------------------------------------------------------------------------------------------- |
| `main.py`                     | Builds the app (`create_app`), including middleware and trusted hosts.                              |
| `config.py`                   | Settings from the environment and the repo-root `.env.local`. It's strict in production.            |
| `deps.py`, `auth.py`          | The internal-secret check, and Clerk token checks for user calls.                                   |
| `routes/`                     | One file per area: `check`, `courses`, `notes`, `devices`, `quota`, `learner`, `pdfs`, `moments`, … |
| `checker/`                    | SymPy maths checking, run in worker processes.                                                      |
| `courses/`, `pdfs/`, `notes/` | PDF ingestion, lessons, notes search (embeddings plus full-text).                                   |
| `quota/`                      | Reserve, refund and finish for the 8 free questions, through Postgres functions.                    |
| `devices/`                    | Desktop sign-in codes and device tokens.                                                            |
| `supabase_rest.py`            | A small PostgREST client.                                                                           |

### Inside `desktop/`

| Path                            | What's there                                                                                                                                  |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `src-tauri/src/lib.rs`          | App start: the main window (it shows the web app), the tray, hotkeys, deep links and the updater.                                             |
| `src-tauri/src/screen/`         | Screen Coach. Pure logic (geometry, protocol, marks, ink planning) builds on every OS; the parts that touch the screen are `#[cfg(windows)]`. |
| `src-tauri/src/screen/win/`     | All Win32/WinRT calls: capture, OCR, input, credentials, HTTP, crypto, UI Automation. Each `unsafe` call is wrapped in a small function.      |
| `src-tauri/src/screen/privacy/` | What's never captured or sent: password fields, private windows, blocklisted apps, redaction.                                                 |
| `overlay-src/`                  | TypeScript for the overlay windows (ink, draw, pointer, notes panel), bundled into `shell/gen/`.                                              |
| `shell/`                        | The overlays' HTML and CSS, plus the generated JS.                                                                                            |

## Where it runs

| What                   | Where                                                        | Notes                                                                                                   |
| ---------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| Website                | Vercel project `neb-web` → myneb.si                          | Separate repo `neb_web`. `LAUNCH_MODE` switches it between waitlist and open.                           |
| Web app                | Vercel project `neb-app` → app.myneb.si at launch            | Only previews exist so far (branch `feat/launch-limits`).                                               |
| API                    | Render (Docker, `backend/`)                                  | Test copy: service `mew`. Production comes from [render.yaml](../render.yaml) at launch.                |
| Database               | Supabase                                                     | Production `gvwynloprjomqqovpoem`. Test copy `qnhfzevygmlgfrbavswq`, in the separate `neb-staging` org. |
| Rate limits, daily cap | Upstash Redis                                                | Separate databases for test and production. Without Redis it falls back to memory.                      |
| Identity               | Clerk                                                        | The development instance for now.                                                                       |
| AI                     | Gemini (answers, embeddings), ElevenLabs (speech in and out) | Server-side only. Previews use the fake model.                                                          |
| Email                  | Resend                                                       | Website only: waitlist and "email me the link".                                                         |

Setting up the test copy is in [PREVIEW_SETUP.md](PREVIEW_SETUP.md). Launch steps and limits are
in [LAUNCH_LIMITS.md](LAUNCH_LIMITS.md).

## A question, end to end (desktop)

1. **The student asks.** They hold the keys, circle part of the screen and ask. The desktop app
   captures **only** that window, with violet edges showing while it captures. It covers
   password fields and private windows, then sends a JPEG and the question to
   `POST /api/screen/circle-ask` with its device token.
2. **The question gate** (`server/question-gate.ts`) checks, in order:
   - the kill switch and the daily cap;
   - whether this is a free follow-up;
   - a verified email;
   - the rate limits;
   - then it reserves a question in Postgres. That's 8 free per account **and** per computer,
     reserved atomically.
3. **The answer:** Gemini answers in a strict JSON schema, made of steps, each with speech and
   drawing actions. ElevenLabs speaks it.
4. **Finish or refund:** the reservation is finished if an answer started, or refunded if it
   failed first. The response carries `X-Neb-Questions-Left`.
5. **The overlays** draw the steps on screen, and the entry is saved to the notebook.

## Working here

- **One milestone at a time,** verified before moving on, with a short report. Security comes
  first.
- **Specs are binding.** Each feature series has a spec whose **Decisions** section must be
  followed. [CLAUDE.md](../CLAUDE.md) lists them: Screen Coach (S),
  Notes Check (N), Notebooks (K), the UI overhaul (U).
- **Ask before** adding a paid service or a major dependency. pnpm only installs versions at
  least 14 days old, and blocks install scripts. Don't work around that.
- **Never run local servers with the live keys** in `.env.local`. Use the test copy, or blank
  them (see `scripts/dev-staging.ps1`).
- **`pnpm check`** runs everything CI runs: format, lint, types and tests.

## The docs

| Doc                                                                                                                | Read it for                                          |
| ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| [BUILD_BRIEF.md](BUILD_BRIEF.md)                                                                                   | The original product brief                           |
| [HANDOFF.md](HANDOFF.md)                                                                                           | Status, decisions, security invariants, recipes      |
| [FEATURES.md](FEATURES.md), [USAGE.md](USAGE.md)                                                                   | What's built and how to use it                       |
| [SCREEN_COACH.md](SCREEN_COACH.md) (+ S3, S3_2, NOTES_CHECK)                                                       | The desktop tutor                                    |
| [NOTEBOOKS_K.md](NOTEBOOKS_K.md)                                                                                   | Notebook tree, PDFs, drawn explanations, handwriting |
| [NEB_APP_UI.md](NEB_APP_UI.md)                                                                                     | The UI system ("the desk")                           |
| [DESKTOP_API.md](DESKTOP_API.md), [DESKTOP_RELEASE.md](DESKTOP_RELEASE.md)                                         | The desktop app's API contract, and releasing it     |
| [LAUNCH_LIMITS.md](LAUNCH_LIMITS.md), [LAUNCH_TESTING.md](LAUNCH_TESTING.md), [PREVIEW_SETUP.md](PREVIEW_SETUP.md) | Launch: limits, testing, the test copy               |
| [MAC_APP.md](MAC_APP.md)                                                                                           | Plan for a macOS version of the desktop app          |
