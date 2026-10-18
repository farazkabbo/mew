# mew

An ambient AI tutor that lives inside your notebook. It stays quiet until it's actually needed,
then answers by voice and in animated ink on the page.

Product brief: [docs/BUILD_BRIEF.md](docs/BUILD_BRIEF.md) · Build status and decisions:
[docs/HANDOFF.md](docs/HANDOFF.md)

## Repository layout

```
frontend/            Next.js 16 app: notebook, courses, and its /api routes (gate, tutor, speech,
                     checks, courses)
backend/             FastAPI on Python 3.12 (internal service: SymPy checks, course ingestion,
                     lessons, retrieval). See backend/README.md
backend/supabase/    Postgres migrations (RLS, pgvector) and their tests (PGlite, no Docker needed)
packages/shared/     Shared zod schemas, prompts and types (mirrored by Pydantic models in backend/)
packages/ink/        Framework-free ink logic: geometry, line segmentation, undo/redo, and the
                     tutor's handwriting (glyphs, LaTeX, placement, plots and diagrams)
scripts/             Dev tooling (`pnpm health`, glyph table builder)
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
  The secret key (which bypasses RLS) is reserved for narrowly scoped server jobs: today only
  course ingestion on the API service, for a course it has just created for the verified user.

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
notebooks saved only in this browser, courses kept in the API's memory, and the same strict
CSP. Production refuses to serve (HTTP 503) without Clerk keys, and the API accepts the local
user only when `APP_ENV=development`, so local mode can't become an auth bypass.

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
4. For courses (signed in), set `SUPABASE_SECRET_KEY` for the API service. It is used only by
   course-building jobs, which outlive a session token, for a course the API has just created
   for the verified user.

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
real gate model and reports accuracy and latency. It needs `GEMINI_API_KEY` and paces itself to
14 requests a minute for Gemini's free tier (`EVAL_RPM=0` turns that off).

## The tutor

When Mew decides to respond, the **tutor** (`/api/tutor`, Gemini Flash) gets the conversation, a
PNG of your three most recent lines, and any recognised text for them. It replies with
`{ speech, actions }`:

- `speech` is streamed out of the JSON as soon as it's complete and spoken right away
  (`/api/tts` proxies ElevenLabs Flash as raw PCM, played gaplessly with Web Audio). Board
  `actions` arrive after and are written on the page as ink (below).
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

## Tutor ink

The tutor never pastes text boxes: its board actions are **handwritten** on the page.

- Glyphs are single-stroke Hershey fonts (see `packages/ink/src/tutor/glyphs/NOTICE.md`),
  scaled to the student's own writing size and wobbled a little per letter.
- `write_math` takes a LaTeX subset (fractions, powers, subscripts, roots, Greek, operators,
  arrows, ∑ ∫ ∏, `\text{}`), parsed by our own small parser; anything else falls back to text.
- A placement engine (occupancy grid) puts each action next to, under or beside the line, in
  free space on screen, and never over the student's strokes.
- Ink writes itself, paced to the speech. Writing or speaking pauses it; it resumes when you're
  quiet, moving out of the way of anything you wrote meanwhile. A turn is one undo step, and
  the ✨ toolbar button (or `T`) hides tutor ink.
- Plots (`draw_plot`), mind maps and flowcharts (`draw_graph`, laid out with ELK) and simple
  sketches (`draw_shapes`) are hand-drawn too (roughjs strokes, our own safe function sampler).

## Checking work

When you pause after writing a line (or ask "is this right?"), the **checker router** verifies
it. Language models never get the last word on arithmetic:

| Content                  | Checker                                                                |
| ------------------------ | ---------------------------------------------------------------------- |
| Algebra, calculus, units | SymPy on the API service: does this line follow from the one above?    |
| Chemical equations       | Atom and charge balance (in the browser)                               |
| Python code              | Run in Pyodide in a sandboxed worker (errors are caught; time-limited) |
| Anything else            | The tutor, with a short rubric                                         |

A verified-correct line gets a small green tick, quietly (no voice, no model call). A verified
mistake is circled in red with a short note and the tutor gives a hint; it's told the verdict
and never contradicts it, and if the model fails the circle still appears. Turn this off with
"Check my steps" in the debug panel.

SymPy runs in worker processes with a hard time limit (and a memory cap on Linux); input is
parsed by SymPy's strict LaTeX parser, never `eval`. Pyodide is self-hosted (copied from
`node_modules` before `dev`/`build`) and runs with its own strict CSP and no network access.

## Courses

**Courses** (sidebar) turns a PDF into a study plan:

1. Upload a chapter, notes or a syllabus (PDF, up to 15 MB). The API parses it (pdfium, in a
   sandboxed process), transcribes scanned pages with Gemini, splits it into page-exact
   passages, embeds them (Gemini embeddings in pgvector) and extracts a concept graph: concepts
   in teaching order, their prerequisites, and their source pages.
2. **Check the plan:** rename, reorder, merge or remove concepts and set an exam date.
3. Study: each concept has a lesson (explanation, worked example, practice questions, page
   references), written the first time it's opened and then cached. "Open the course notebook"
   gives the course its own notebook, where the tutor is handed the passages relevant to each
   question and cites their pages.

Without a Gemini key the pipeline still works (concepts from the PDF's headings, lexical
search). In local mode courses live in the API's memory; signed in, they live in Supabase under
RLS (apply the migrations first). `pnpm eval:course` checks against the real model that answers
cite the right page.

## Learning and review

Progress is honest: every answer is recorded with how it came about (**on your own**, **with a
hint**, or **after being shown**), and only answers given on your own count as knowing a
concept. Each concept shows one of _Not started · Explored · Practised with hint · Checked ·
Revisit_, and FSRS (ts-fsrs) schedules when it comes back.

- **Lesson practice:** take the hint if you need it, check your answer against the model answer,
  and say whether you had it.
- **Quiz me** (course page, lesson, Review, or the sidebar in a course notebook): the tutor asks a
  question in the notebook; answer on the page or out loud, then check it (or say "is this
  right?"). The answer is graded against the lesson's model answer, ticked or circled in ink, and
  recorded. Asking the tutor for help, taking the hint or a wrong first try makes it "with hint".
  Without a model key you grade yourself against the model answer.
- **Review** (sidebar): concepts due now, across all courses.
- **Exam date:** the study plan spreads unchecked and to-revisit concepts over the days left,
  brings back reviews due before the exam, and keeps the day before for a final pass.

`pnpm eval:quiz` checks the grader against the real model (`EVAL_RPM` paces it; set
`GEMINI_TUTOR_MODEL` to try another model).

## Quality gates

```sh
pnpm check                     # prettier, ESLint, tsc, vitest across the TS workspaces + API
E2E_BASE_URL=http://localhost:3100 pnpm --filter @mew/frontend e2e
                               # Playwright (30 tests): starts its own web (:3100) and API (:8100)
                               # servers in local mode, beside any dev server you have running
pnpm --filter @mew/backend audit:py  # pip-audit of the API's runtime dependencies
pnpm audit --prod              # npm advisories
```

The database tests in `backend/supabase/tests` apply every migration to an in-memory Postgres (PGlite)
that emulates Supabase's roles, `auth.jwt()` and storage, with pgvector. They then attack the
policies: cross-user reads and writes, ownership spoofing, attaching rows to someone else's
notebook or course, retrieving another user's passages, logging attempts against someone else's
concept (or the wrong course), other users' storage folders, anon access, and column-level
tampering (including rewriting or backdating attempts).

The Playwright suite runs one test at a time against a web server on :3100 (its own
`.next-e2e` build folder) and the real API on :8100, both started by Playwright in local mode
with a throwaway internal secret and no model keys. Model calls are mocked per test; SymPy,
PDF parsing, retrieval and Pyodide run for real.

CI (`.github/workflows/ci.yml`) runs all of the above plus a production build and a gitleaks
secret scan. Actions are pinned to commit SHAs, and Dependabot keeps them and all dependencies
current.

## Deploy

- **API → Render.** `render.yaml` defines a Docker web service (`backend/Dockerfile`,
  non-root, health check `/health`). Apply it as a Blueprint, then set `INTERNAL_API_SECRET`
  (same value as the web app), `CLERK_ISSUER` and `CLERK_AUTHORIZED_PARTIES` (your web origin);
  the service refuses to boot in production without them. For courses also set
  `GEMINI_API_KEY`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` and
  `SUPABASE_SECRET_KEY`. Use an instance with at least 2 GB of RAM (the SymPy and PDF workers
  run in their own processes; the free plan's 512 MB is not enough).
- **Database.** Apply `backend/supabase/migrations/*.sql` in order (see Supabase above).
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
- Untrusted input is processed out of process: SymPy checks and PDF parsing run in sandboxed
  worker processes with hard time limits (and memory caps on Linux); students' Python runs in
  a Pyodide worker with its own CSP, no network access, and a timeout.
- Uploads are checked by their bytes (a PDF must start with `%PDF-`) and capped at 15 MB while
  streaming. Every route is same-origin only (GETs refuse cross-site requests), rate-limited
  per user and schema-validated.
- Model output is always validated against a schema; speech, handwriting, images and course
  material are treated as data, never as instructions.
