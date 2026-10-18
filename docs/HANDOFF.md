# Handoff: state of the build

Context for a new working session. Read this, then [BUILD_BRIEF.md](BUILD_BRIEF.md) (the
product brief), then the root [README.md](../README.md). Last updated 2026-10-17 (after M7).

## 1. Working agreement (from the project owner)

- Build **one milestone at a time**. After each: run it, verify the acceptance criteria, and
  report what works and what doesn't, then wait before starting the next.
- **Never commit or push.** The owner commits. Finish by giving the exact `git` commands
  (a new branch per piece of work, then add, commit and push).
- **Security first.** Treat every new endpoint, input and dependency as hostile until checked.
- **Check the current official docs** before using any third-party API (model IDs, endpoints,
  SDK shapes). Don't trust memory: the Gemini SDK, for example, moved to an Interactions API.
- **Ask before adding paid services or major dependencies** not listed in the brief.
- **Stop any dev server you start** before handing back (see §8). A leftover server once blocked
  the owner's `npm run dev` with `EADDRINUSE`.
- Write tests, including tests that would catch a regression, and run the whole suite before
  reporting.

## 2. Where things are

| Milestone            | Status                                                                                 |
| -------------------- | -------------------------------------------------------------------------------------- |
| M0 Scaffold          | ✅ Done                                                                                |
| M1 Notebook canvas   | ✅ Done (plus lasso, live sync between tabs, stacked-fraction line segmentation)       |
| M2 Voice in + Mew v1 | ✅ Done. Gate verified on the real model (`pnpm eval:mew`).                            |
| M3 Tutor + voice out | ✅ Built. Real tutor replies verified with Flash-Lite; see §9 for the voice and quota. |
| M4 Ink output        | ✅ Done (Hershey glyphs, LaTeX subset, placement, animation, undo, hide toggle)        |
| M5 Checking work     | ✅ Done (SymPy service, chemistry balance, Pyodide code runner, quiet ticks)           |
| M6 Visuals           | ✅ Done (plots, mind maps, flowcharts, sketches: ELK + roughjs → ink)                  |
| M7 Courses           | ✅ Done locally; **Supabase migrations not applied yet** (§6)                          |
| M8 Learner model     | ⏭ Next (another developer). Notes in §10.                                              |
| M9–M10               | Not started                                                                            |

Tests: **419 unit tests** (frontend 152, ink 108, backend 83, shared 51, database 25) and **27
Playwright tests**. `pnpm check` and the Playwright suite both pass.

Real-API checks run on 2026-10-17 with the owner's keys: the gate (32 labelled utterances), the
tutor schema, course ingestion (Gemini embeddings, concept graph, OCR prompt, lessons) and
`pnpm eval:course` (answers cite the right page, 2/2). See §9 for what blocked the rest.

## 3. Layout

```
frontend/                     Next.js 16 app (UI + its /api routes)
  src/proxy.ts                Clerk middleware + nonce CSP (or "local mode", see §4)
  src/server/                 server-only: env, http (origin, body limits, readForm), rate-limit,
                              gemini (schema pruning!), mew-gate, tutor, elevenlabs, png, csp,
                              api-client (→ FastAPI), courses (calls FastAPI as the user)
  src/app/api/                health, mew, stt/token, tutor (NDJSON), tts, recognize,
                              check/math (→ SymPy), courses/** (→ FastAPI)
  src/app/(app)/              notebook, courses, courses/[id], courses/[id]/concepts/[conceptId]
  src/features/notebook/      canvas, engine (PageEngine: undo, IndexedDB, tab sync,
                              addTutorStrokes), repository (notebooks can have a courseId)
  src/features/tutor/         controller (turns, barge-in, checks, course context), ink.ts
                              (TutorInk: plans and animates board actions), context.ts
  src/features/check/         WorkChecker (router: SymPy / chemistry / code), Pyodide runner
  src/features/courses/       course list/upload, scope review, study plan, lesson view
  src/features/mew/           gate, triggers, controller (pen-pause quick checks), session wiring
  public/workers/             code-runner.mjs (Pyodide worker; its own CSP, see next.config.ts)
  public/pyodide/             copied from node_modules by scripts/copy-pyodide.mjs (gitignored)
  e2e/                        Playwright: notebook, voice, tutor, ink, check, visuals, courses
  evals/                      eval:mew, eval:tutor, eval:course (real APIs; skip without keys)
backend/src/mew_api/          FastAPI: auth, config, deps (Caller: Clerk user or local user)
  checker/                    SymPy step checker (latex.py, steps.py) + sandbox.py (process pool)
  courses/                    pdf (pdfium), chunking, embeddings, llm, prompts, concepts,
                              lessons, store (memory) + supabase_store, ingest
  routes/                     health, me, check, courses
backend/supabase/             migrations (core + courses) and RLS tests on PGlite (+ pgvector)
packages/shared/              zod schemas (notebook, mew, tutor, check, course), reconcileMarks,
                              chemistry balance, prompts (mew, tutor v4, checker)
packages/ink/                 geometry, segmentation, history, outline, …, and tutor/:
                              glyphs (Hershey JSON + NOTICE), typeset (text, LaTeX), placement,
                              inkify, board (planner), actions, visuals (plot, graph, shapes)
scripts/                      health.ts, build-glyphs.ts (regenerates the glyph table)
```

## 4. Decisions and deviations from the brief (and why)

Earlier decisions (M0–M3) still hold: Clerk instead of Supabase Auth, local mode without Clerk
keys (503 in production), FastAPI internal-only on Render, hosted Supabase, Gemini via the
Interactions API with `store: false`, ElevenLabs without SDKs, early speech extraction, prompts
as TS modules, in-memory rate limits, TypeScript ~6.0 / ESLint 9 pins, pnpm 14-day release age,
Cache Components off. New ones:

- **Glyphs: Hershey fonts** (Simplex Roman, Greek, maths symbols) converted by
  `scripts/build-glyphs.ts` from `kamalmostafa/hershey-fonts@1356bf2` into our own JSON. The
  licence requires its acknowledgements to ship with the data: `packages/ink/src/tutor/glyphs/
NOTICE.md`. ≈ ⇌ ⇒ ↔ are drawn by the script.
- **LaTeX → ink is our own small parser** (no KaTeX): depth/size capped, falls back to text.
- **Tutor ink** is planned in `packages/ink` (framework-free, unit-tested) and animated by
  `TutorInk` on the canvas live layer. A turn's ink is one undo step (`addTutorStrokes`, change
  type `"tutor"`, so Mew doesn't treat it as the student writing). Barge-in pauses the ink; it
  resumes after 1.5 s of quiet, moving any unwritten part the student has written over.
- **Verifiers outrank the model** (`reconcileMarks`): marks never contradict a check, and the
  line being checked gets its circle or tick even if the model fails or forgets.
- **Quiet checks:** after a writing pause, a verified-correct line gets a small tick with no
  model call; a verified mistake starts a `check_work` turn. Undecided → the gate decides.
- **SymPy runs in a process pool** with a hard timeout (a stuck worker is killed) and, on Linux,
  a memory cap. Uses SymPy's **Lark** LaTeX parser (strict), never `parse_expr`/`sympify` (eval).
- **Pyodide is self-hosted** (`public/pyodide`, copied before dev/build) and runs in a module
  worker with its own CSP and its network APIs removed. Its stdlib is published as `.dat`
  (some browsers/networks block `.zip`/`.bin` URLs outright; see §8).
- **Visuals:** plots use our own safe expression compiler (no eval) and sampler; mind maps use
  ELK's radial layout, flowcharts its layered layout; roughjs draws one-pass pen paths.
- **PDF parsing uses pypdfium2, not PyMuPDF.** PyMuPDF is AGPL-3.0 (or commercial): using it
  in this hosted service would oblige publishing its source. pdfium is BSD-3/Apache-2.0.
- **Courses in Supabase are written two ways:** everything the user does goes through
  PostgREST/Storage with the user's Clerk token (RLS applies). Ingestion jobs outlive the
  ~60 s Clerk token, so they use the **secret key**, only for a course the route has just
  created for the verified caller, and still set/filter `user_id` on every row.
- **Local mode courses** live in the API process's memory (`MemoryCourseStore`), per user,
  isolated like RLS. The API accepts the local user only when `APP_ENV=development`.
- **No model key?** Ingestion still works: heading-based concepts and lexical (hashed)
  embeddings, recorded per source so queries use the same embedder.
- **Gemini schema rules** (verified against the API): `oneOf` must become `anyOf` (zod's
  discriminated unions; dropping it had silently stripped the board actions from the tutor's
  schema), and **no `minItems`/`maxItems`** (with unions or nested arrays Gemini answers 400).
  zod/Pydantic still enforce the bounds; Pydantic trims over-long model text instead of failing.
- **Backend prompts** (concept graph, lesson, OCR) live in `backend/src/mew_api/courses/
prompts.py`, versioned like the TS ones (Python can't import the TS modules).

## 5. Security model (keep these invariants)

- Every POST route: `assertSameOrigin` → `requireUserId` → `enforceRateLimit` → `readJson` /
  `readForm` with a byte cap. GET routes use `assertNotCrossSite` (browsers send no Origin on
  same-origin GETs). Errors go through `handle()`; API failures map to safe messages.
- Images from the client are verified PNGs (`png.ts`); uploads are verified PDFs by their bytes
  (`%PDF-`), capped at 15 MB in Next (streaming) and again in FastAPI.
- Untrusted parsing runs out of process: SymPy (checker pool), PDFs (ingest pool), student code
  (Pyodide worker, terminated on timeout).
- Strict nonce CSP; `connect-src` unchanged. `/workers/*` and `/pyodide/*` skip the proxy and get
  `default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'`.
- The database denies by default: RLS on every table (courses too), column-level grants,
  composite foreign keys, `match_chunks` is `SECURITY INVOKER`, and storage objects are scoped
  to `<user id>/` in a private bucket. `service_role` keeps Supabase's default grants.
- Model output is always schema-validated. Speech, handwriting, images and course material are
  data, never instructions (stated in every prompt).
- Never put a JWT-shaped literal in source: gitleaks flags it (see `.gitleaksignore`).

## 6. Environment

One file: **`.env.local` at the repo root** (gitignored), read by both frontend and backend.
Template: `.env.example`. As of this session all keys are set **except `SUPABASE_SECRET_KEY`**
(needed for course ingestion when signed in).

**Before courses work when signed in (Clerk mode):**

1. Apply the migrations to the hosted project (`backend/supabase/migrations/*.sql`, in order;
   README → Supabase). The courses migration also creates the `course-sources` bucket.
2. Make sure Supabase third-party auth trusts Clerk (README → Supabase step 1); `/status` checks.
3. Set `SUPABASE_SECRET_KEY` (API service only; Render too).

Render also needs `GEMINI_API_KEY`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
and `SUPABASE_SECRET_KEY` (see `render.yaml`), and more than the free plan's 512 MB of RAM.

## 7. Commands

```sh
npm run dev            # frontend :3000 + backend :8000 (same as pnpm dev)
pnpm health            # both services + frontend→backend link
pnpm check             # prettier, eslint, tsc, all unit tests (incl. backend via uv)
E2E_BASE_URL=http://localhost:3100 pnpm --filter @mew/frontend e2e
                       # Playwright starts its own Next (:3100, .next-e2e) and API (:8100)
pnpm --filter @mew/frontend build
pnpm eval:mew / eval:tutor / eval:course   # real APIs (skip without keys)
EVAL_RPM=0 pnpm eval:mew                    # no pacing (paid tier)
cd backend && uv run --frozen pytest | ruff check . | mypy
pnpm tsx scripts/build-glyphs.ts <dir with futural.jhf, greeks.jhf, mathupp.jhf>
```

## 8. Pitfalls on this machine (Windows, Git Bash)

- **Bash heredocs and `node -e` swallow backslashes** (`\\.` → `\.`, `’` → the character).
  Write source with the file tool; in Python tests use `chr(0x2019)`. `proxy.test.ts` guards
  the proxy matcher regex.
- **One `next dev` per build folder.** Next refuses a second dev server on `.next` ("Another
  next dev server is already running"). Playwright uses `NEXT_DIST_DIR=.next-e2e` and port 3100,
  so it runs beside your own dev server; set `E2E_BASE_URL` accordingly.
- **This machine's browsers refuse URLs ending in `.zip` or `.bin`** (blocked before the request
  leaves the browser, status 204; both Edge and Chromium; no proxy or policy found). Hence the
  Pyodide stdlib is served as `.dat`.
- Stopping a background shell doesn't kill the servers it started. Find and kill them with
  PowerShell: `Get-CimInstance Win32_Process | ? { $_.CommandLine -match 'GitHub\\mew' -and
$_.CommandLine -match 'next|uvicorn' }`, then confirm ports 3000, 3100, 8000, 8100 are free.
  The SymPy/PDF pools spawn Python children; check for orphans the same way.
- `uv run python -I` ignores `PYTHON*` env vars; the console is cp1252, so print with
  `sys.stdout.reconfigure(encoding="utf-8")`.
- Gemini free tier: 15 requests/min on Flash-Lite (`eval:mew` paces itself at 14/min).
- Moving folders breaks `node_modules` and `.venv`; delete both and reinstall.
- After editing `.env.local`, restart the dev servers.
- React's compiler lint rules are on: no ref reads or impure calls during render, and no
  synchronous `setState` in effects.

## 9. Known limitations / open items

- **Gemini quota:** on the owner's free-tier project, `gemini-3.8-flash` (the default tutor
  model) took ~50 s per call or timed out, and other Flash models returned 429 "quota
  exceeded"; only Flash-Lite responded. `eval:tutor` can't pass until billing is enabled (or
  `GEMINI_TUTOR_MODEL` is set to a model with quota). Gate latency is ~0.8 s (brief target
  0.4 s for v1).
- **ElevenLabs voice:** the configured voice is a Voice Library voice, which free accounts can't
  use over the API (402 `paid_plan_required`). Pick a default voice in the ElevenLabs app (or
  add credits); speech-to-text tokens work.
- Course ingestion runs as a FastAPI background task: a restart mid-ingestion leaves the course
  "processing" (no job queue yet). The local store is in memory (lost on API restart).
- Units checking covers `\text{…}` units with SI conversion; inequalities, `\pm` and some
  notations are "unknown" (never guessed).
- The code checker only reports failures (a clean run proves little without expected output).
- Two tabs editing the same page: last write wins. No cloud sync of strokes yet.
- Echo handling for the tutor's voice is heuristic (word overlap); headphones are best.
- The conversation drawer and settings screen aren't built (settings live in the debug panel).

## 10. Next: M8 (learner model + review)

What exists to build on:

- `concepts` (ordered, with `concept_edges` prerequisites and `source_pages`) per course, and
  `courses.exam_date`. Lessons with practice questions (`concepts.lesson`, cached).
- Check verdicts per line (`LineCheck`) on every check_work turn (`useTutor` turns keep
  `checks`), and whether a hint/explanation preceded them (turn intents) — the raw material for
  `attempts.evidence` (`independent | with_hint | after_explanation`).
- Notebooks carry `courseId`; the tutor gets course passages via `/api/courses/[id]/retrieve`.

To build (brief §9, §10): `attempts` and `review_cards` tables (follow the courses migration's
RLS/grant/FK pattern and add PGlite tests), FSRS via `ts-fsrs`, concept status labels, the exam
plan, and Quiz me. Map concept ↔ notebook line (e.g. by retrieval of the recognised line) to
attribute attempts.
