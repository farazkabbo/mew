# Onboarding a developer to mew (instructions for Claude)

This file is written for a Claude session helping a new developer get started. A developer can
start one with:

> Read ONBOARDING.md, explain the project to me, and set it up on this machine.

**Claude: when asked to onboard someone, work through the steps below in order.** Explain as you
go, keep each step's output short, and stop to ask whenever a step needs a decision, an account
or a key that only the developer has. This file can go stale: if it disagrees with
[docs/HANDOFF.md](docs/HANDOFF.md) (build status, decisions) or the [README](README.md) (setup
details), trust those and say so.

## Ground rules for the session

- **Never print secrets.** Don't echo `.env.local` or any key. When checking whether a variable
  is set, print only its name and "set" / "empty".
- **Don't fill in keys yourself** or invent values. Ask the developer to paste them into
  `.env.local` (the one exception: `INTERNAL_API_SECRET`, which you generate, see step 4).
- **Ask before installing anything system-wide** (Node, pnpm, uv, browsers). Project
  dependencies (`pnpm install`, `uv sync`) are fine to run.
- **Don't run the evals** (`pnpm eval:mew`, `eval:tutor`, `eval:course`, `eval:quiz`) unless asked.
  They call paid APIs, and on Gemini's free tier a couple of runs can use up a whole day's quota.
- **Never commit or push.** The team commits; suggest the commands instead.
- **Stop any server you start** before handing back, and check the ports are free (step 6).

## Step 1: explain the project

Cover these points in your own words (a few minutes of reading, not a lecture). Offer to go
deeper on any of them.

**What it is.** An AI tutor that lives inside a digital notebook. The student writes by hand
(pen, mouse or trackpad) and talks while studying. The tutor stays quiet until it's actually
needed, then answers out loud and by writing on the page in animated "ink": short text, maths,
plots, mind maps and flowcharts. It checks work, builds a course from the student's own PDF,
and tracks honest progress. The full product brief is [docs/BUILD_BRIEF.md](docs/BUILD_BRIEF.md).

**The core loop.**

```
mic ──► ElevenLabs Scribe (speech-to-text) ──┐
pen ──► stroke events (write / pause / erase) ┼──► Mew, the gate: should the tutor respond?
                                              │       "ignore" (the default) → nothing happens
                                              ▼
           context: transcript + image of recent handwriting + recognised text
                    + course passages + the quiz question, if any
                                              ▼
                 Gemini (tutor) ──► JSON: speech + board actions
                                              ▼
          speech ──► ElevenLabs TTS (voice)    board actions ──► ink drawn on the page
```

Talking or writing over the tutor interrupts it ("barge-in").

**Where things are.**

| Folder              | What's there                                                                |
| ------------------- | --------------------------------------------------------------------------- |
| `frontend/`         | Next.js 16 app (React 19): notebook, courses, review, and its `/api` routes |
| `backend/`          | FastAPI (Python 3.12, managed by uv): SymPy checks, PDF ingestion, lessons  |
| `backend/supabase/` | Postgres migrations with row-level security, and tests that attack them     |
| `packages/shared/`  | zod schemas, prompts and pure logic shared by the app                       |
| `packages/ink/`     | Framework-free ink: line segmentation, undo, the tutor's handwriting        |
| `desktop/`          | Mew for Windows (Tauri v2, Rust): summon hotkey, tray, review reminders     |
| `ml/`               | Mew v2: training the in-browser gate model from labelled decisions          |
| `docs/`             | The product brief and the handoff (status, decisions, pitfalls)             |

**How the pieces talk.** The browser only talks to the Next.js server. The Next server calls
Gemini and ElevenLabs (keys never reach the browser) and calls the FastAPI service with a shared
secret. Supabase is reached with the signed-in user's own token, so row-level security applies.
Identity is Clerk.

**Two modes.**

- **Local mode** (no Clerk keys): no sign-in, notebooks saved in the browser, courses kept in
  the API's memory. This is the quickest way to start, and what the end-to-end tests use.
- **Signed-in mode** (Clerk + Supabase): real accounts and data in Supabase. Needs the setup in
  the README's Clerk and Supabase sections.

**Status.** All the brief's milestones (M0–M10) are built: canvas, voice and the gate, tutor
replies with voice, ink, work checking, visuals, courses, the learner model (statuses, spaced
review, exam plan, "Quiz me"), settings and the Windows desktop app (M9), and Mew v2's pipeline
(M10: opt-in logging, Teach Mew, dataset, training, in-browser model; no real model is trained
yet). Check the table at the top of [docs/HANDOFF.md](docs/HANDOFF.md) for the current state and
its §10 for what comes next.

**How the team works** (from the handoff): one milestone at a time, verified before moving on;
security first; check current official docs before using a third-party API; ask before adding
paid services or major dependencies.

## Step 2: check prerequisites

Run these and report what's missing:

```sh
node --version    # needs 22 or newer (CI uses 24)
pnpm --version    # needs 12.x (the repo pins pnpm@12.14.0)
uv --version      # any recent version; it installs Python 3.12 for the API itself
git --version
```

If something is missing, tell the developer how to install it and **ask before doing it**:

- Node.js: https://nodejs.org (LTS), or a version manager (nvm, fnm, volta).
- pnpm: `npm install -g pnpm@12.14.0`. (Corepack isn't bundled with Node 25 and newer, so don't
  rely on `corepack enable`.)
- uv: https://docs.astral.sh/uv/getting-started/installation/

Only if the developer will work on them (ask first; both are large):

- **Desktop app** (`desktop/`): Rust via https://rustup.rs (stable, MSVC on Windows) plus the
  Visual Studio C++ Build Tools. Check with `cargo --version`.
- **Training Mew v2** (`ml/`): `cd ml && uv sync` installs PyTorch and friends (~1 GB).

## Step 3: install dependencies

From the repo root:

```sh
pnpm install              # all JS workspaces (frontend, packages, database tests)
cd backend && uv sync && cd ..   # the API's Python environment (backend/.venv)
```

Notes:

- pnpm only installs package versions published at least 14 days ago (`minimumReleaseAge` in
  `pnpm-workspace.yaml`), and blocks install scripts except those allowed there. That's
  deliberate supply-chain hardening; don't bypass it.
- The Pyodide runtime (Python in the browser, for checking code) is copied into
  `frontend/public/pyodide/` automatically before `dev` and `build`.

## Step 4: create `.env.local`

There is **one** env file, `.env.local` at the repo root, read by both the web app and the API.
It is gitignored. Every variable is explained in [.env.example](.env.example).

```sh
cp .env.example .env.local
```

Then set `INTERNAL_API_SECRET` to a fresh random value (at least 32 characters). You may
generate and write this one yourself:

```sh
python -c "import secrets; print(secrets.token_urlsafe(48))"
```

That's enough for **local mode**: the app starts without any other key. Explain what each kind
of key adds, and ask which ones the developer has:

| Keys                                                                     | What they enable                                                        |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| `GEMINI_API_KEY`                                                         | The gate, tutor replies, handwriting recognition, lessons, quiz grading |
| `ELEVENLABS_API_KEY` + `ELEVENLABS_VOICE_ID`                             | Listening (speech-to-text) and the tutor's voice                        |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, `CLERK_ISSUER`  | Sign-in (switches off local mode)                                       |
| `NEXT_PUBLIC_SUPABASE_URL`, `..._PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY` | Cloud storage for courses when signed in                                |

Without a Gemini key the app still runs: the gate decides obvious cases by rule and stays quiet
otherwise, and courses use heading-based concepts and keyword search.

Known gotchas with keys (learned the hard way):

- **Gemini free tier is tight.** Flash-Lite allows about 15 requests a minute; Flash about 5 a
  minute and 20 a day. Real use (the gate, handwriting recognition and the tutor all call it)
  hits those limits quickly, and Mew then goes quiet or answers late. Billing on the Gemini
  project removes this. To save Flash quota during development, set
  `GEMINI_TUTOR_MODEL=gemini-3.5-flash-lite`.
- **ElevenLabs: free accounts can't use Voice Library voices through the API** (every request
  fails with 402 and the tutor is silent, with captions only). Use one of ElevenLabs' own
  voices instead, e.g. George, `JBFqnCBsd6RMkjVDRZzb` (verified to work on a free key), or add
  credits to the ElevenLabs account.
- Signed-in mode also needs the Supabase migrations applied and Supabase set to trust Clerk:
  follow the README's Clerk and Supabase sections; don't improvise this part.

After editing `.env.local`, dev servers must be restarted.

## Step 5: verify the setup

```sh
pnpm check     # formatting, lint, type checks and every unit test (JS and Python)
```

It takes a few minutes and should pass on a fresh clone. Then start the app:

```sh
pnpm dev       # web on http://localhost:3000, API on http://127.0.0.1:8000
pnpm health    # in another terminal: both services, and the web → API link
```

Ask the developer to open http://localhost:3000/notebook and draw something; strokes should
survive a reload. With keys set, the bug icon opens the debug panel, where they can type a
sentence (e.g. "why does the force cancel out?") to see Mew's decision without a microphone.

Optional, the end-to-end tests (Playwright starts its own servers on ports 3100 and 8100, in
local mode, with no keys, so they spend nothing):

```sh
# Uses Microsoft Edge by default. Without Edge, install Chromium once and pick it:
pnpm --filter @mew/frontend exec playwright install chromium
E2E_CHANNEL=chromium E2E_BASE_URL=http://localhost:3100 pnpm --filter @mew/frontend e2e
```

In PowerShell, set the variables first instead: `$env:E2E_CHANNEL="chromium";
$env:E2E_BASE_URL="http://localhost:3100"`, then run the command.

## Step 6: hand back

- Stop the servers you started. Stopping a terminal doesn't always stop them: check that ports
  3000, 3100, 8000 and 8100 are free, and look for leftover `next`, `uvicorn` or Python worker
  processes from this repo (the API's SymPy and PDF pools spawn child processes).
- Summarise for the developer: what's installed, which keys are set (names only) and which
  features they unlock, anything that failed and why, and where to read next:
  [docs/HANDOFF.md](docs/HANDOFF.md) for decisions, security rules and recipes ("add a route",
  "add a table", "add a board action"), and [backend/README.md](backend/README.md) for the API.

## Troubleshooting

| Symptom                                               | Likely cause                                                                                |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `EADDRINUSE` on 3000 or 8000                          | A dev server is still running (see step 6)                                                  |
| "Another next dev server is already running"          | One `next dev` per build folder; stop the other one                                         |
| Mew never responds; dev log shows 429 or "timed out"  | Gemini quota or a Google-side slowdown. See `frontend/.next/dev/logs/next-development.log`  |
| Captions appear but no voice; log shows `[tts] … 402` | Voice Library voice on a free ElevenLabs plan (see step 4)                                  |
| `/notebook` redirects to sign-in                      | Clerk keys are set, so local mode is off                                                    |
| Courses fail when signed in                           | Supabase migrations not applied, or `SUPABASE_SECRET_KEY` missing                           |
| Errors after moving the repo folder                   | `node_modules` and `backend/.venv` break when moved: delete both and reinstall              |
| Bash commands mangle quotes or backslashes (Windows)  | Git Bash heredocs; write scripts to a file instead (more in the handoff's pitfalls section) |
