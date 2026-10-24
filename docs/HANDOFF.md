# Handoff: state of the build

Context for a new working session. Read this, then [BUILD_BRIEF.md](BUILD_BRIEF.md) (the
product brief), then the root [README.md](../README.md) and [backend/README.md](../backend/README.md).
Last updated 2026-10-21, after M9 and M10 (every milestone of the brief is built).

## 1. Working agreement (from the project owner)

- Build **one milestone at a time**. After each: run it, verify the acceptance criteria, and
  report what works and what doesn't, then wait before starting the next (unless the owner
  asks for several in a row, as for M9 and M10).
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
| M2 Voice in + Mew v1 | ✅ Done. Gate verified on the real model (`pnpm eval:mew`: 32/32).                     |
| M3 Tutor + voice out | ✅ Built. Real tutor replies verified with Flash-Lite; see §9 for the voice and quota. |
| M4 Ink output        | ✅ Done (Hershey glyphs, LaTeX subset, placement, animation, undo, hide toggle)        |
| M5 Checking work     | ✅ Done (SymPy service, chemistry balance, Pyodide code runner, quiet ticks)           |
| M6 Visuals           | ✅ Done (plots, mind maps, flowcharts, sketches: ELK + roughjs → ink)                  |
| M7 Courses           | ✅ Done; migrations applied to the hosted project on 2026-10-22 (§6)                   |
| M8 Learner model     | ✅ Done (attempts + evidence, statuses, FSRS reviews, exam plan, Quiz me, Review page) |
| M9 Desktop + polish  | ✅ Done for **Windows** (Tauri: hotkey, tray, reminders), PWA, settings, intro, errors |
| M10 Mew v2           | ✅ Pipeline done (opt-in logging → Teach Mew → dataset → training → in-browser model)  |

**Screen Coach** (new feature, [SCREEN_COACH.md](SCREEN_COACH.md); its Decisions section is
binding): **S0–S3 built** (2026-10-22), **S4 built** (2026-10-23). Desktop code is in
`desktop/src-tauri/src/screen/`.

- **S0 (plumbing):** local settings + opt-in, hotkeys, an in-memory capture with
  Windows.Graphics.Capture, the edge glow and tray states, plus
  `scripts/check-no-screenshots.ps1`.
- **S1 (privacy layer):** blocked apps, password fields (UI Automation), private windows, calls
  and microphone, blackout in monitor captures, and on-device OCR redaction (fail closed). See
  desktop/README.md for details and limits.
- **S2 (ask about your screen):**
  - Device sign-in per decision 8: `device_tokens` migration, FastAPI `routes/devices.py`, Next
    `/api/devices/*`, the `/desktop/link` page, and Settings → Signed-in devices.
  - `/api/screen/ask`: Gemini, the rule-based safety check, speech streamed first.
  - Hold-to-talk with manual commit (`features/screen/`).
  - Rust side: PKCE pair, Credential Manager, a WinHTTP upload from a wipeable buffer
    (`account.rs`, `ask.rs`).
- **Tests:**
  - 72 Rust unit tests, plus 3 real-Windows tests (`cargo test -- --ignored`). One is an
    end-to-end S2 test against running dev servers and real Gemini: link → capture → ask →
    sign out → 401.
  - Threat checks 3 (redaction) and 4 (prompt injection) pass.
- **Still to verify by hand:** the hotkey flow, password fields, InPrivate, calls, and voice
  (microphone and TTS) while the main window is hidden in the tray.
- **Not done yet:** revoking device tokens on password change. This needs a Clerk webhook;
  account deletion and in-app sign-out already revoke them.
- **Database:** all migrations are applied to the Supabase project (`gvwynloprjomqqovpoem`,
  confirmed by the owner), including `foreign_key_indexes` and `device_tokens`
  (2026-10-22); see §6.
- **S3 (annotate on screen + save to notebook)** — brief `SCREEN_COACH_S3.md`, decision 9:
  - Ink: the tutor's v2 actions (`focus_region`, `circle_region`, `underline`, `highlight`,
    `point_at`, `margin_note`, `write_step`) planned by `packages/ink/src/tutor/screen/plan.ts`
    beside the on-screen text (OCR rectangles), drawn by a click-through overlay excluded from
    capture, faded when the content moves, re-placed by "show that again".
  - Clips: Ctrl+Alt+C, "save this" or the ink pill → the local preview → `/api/screen/clips` →
    FastAPI `routes/clips.py` (re-checks the device token) → the private `clips` bucket and the
    `clips` table. The notebook builds the page locally (`useClipImport`, Dexie v2 `images`
    store), draws the picture under the ink, keeps the tutor's ink off it, shows the source line
    with its link, and passes the clip's text to the tutor (`clippedText`, tutor prompt v6).
  - Screen tutor prompt v2, reanchor prompt v1; consent version 2 (the settings page explains ink
    and saving, so earlier consent no longer turns Screen Coach on).
  - `clips` migration applied to the hosted project (2026-10-22); the security advisor reports
    nothing.
- **Still to verify by hand (S3):** ink at 150 % and on a second monitor with other scaling,
  fading on scroll in Edge's PDF viewer and on YouTube, the pill never taking focus, Alt+Tab not
  showing the overlay, the overlay absent from a Teams/OBS capture, a full save in the running app
  (preview → Save → notebook page), and `check-no-screenshots.ps1` after a clip is cancelled.
- **S4 (coach mode)** — decision 10 of SCREEN_COACH.md:
  - **The walkthrough lives on the server.** Its state machine is pure TypeScript
    (`packages/shared/src/coach-machine.ts`: hint ladder, the 0.75 confidence rule, off track,
    3 retries per step, confirming, pause, stop, resume, completion), run by
    `frontend/src/server/coach/run.ts` behind `/api/screen/coach/start`, `/resume` and `/step`
    (device token). Walkthroughs are stored by FastAPI (`routes/walkthroughs.py`, migration
    `walkthroughs`: text only, compare-and-set on `revision`, the plan can't change).
  - **Models:** the planner (`coach-planner.v1`, the screen model) plans 3–15 steps and finds
    step 1's control; the verifier (`coach-verifier.v1`, `GEMINI_VERIFIER_MODEL`) checks each step
    and finds the next control in the same call. Hints 1 and 3 are planned text. Every model text
    passes the rule-based safety check (`coachPlanReasons`, `coachVerdictReasons`).
  - **Desktop:** `coach_mode.rs` (requests, replies, the progress pill, ending on pause),
    `walkthrough.rs` (pure: bodies, reply checks, words → events, pill view and placement),
    coach words in `intent.rs`, the pill page `overlay-src/coach-pill.ts`. During a walkthrough
    the hotkey captures the monitor, ink doesn't take Esc, and the ink pill isn't shown; a
    one-time notice says coach mode sees the whole monitor.
  - A question asked mid-walkthrough is answered in its context (screen tutor prompt v3).
  - Rate limits: `coachStart*` (4/min, 30/day), `coachStep*` (20/min, 400/day, 4,000/month).
  - **The `walkthroughs` migration is not applied to the hosted project yet** (needs the owner's
    go).
  - **To verify by hand:** the acceptance check, a 5+ step walkthrough in Excel or Word (e.g.
    "teach me how to make a pivot table"), saying "done" once without doing the step (it must be
    caught and hinted), "I'm stuck" (an arrow with the control's name), the pill's buttons and
    its position, Stop then "continue where we left off", Esc still reaching Excel during a
    walkthrough, and pausing Screen Coach mid-walkthrough. The ignored Rust test
    `coach_e2e_plans_a_walkthrough_and_catches_a_skipped_step` does the first part against the dev
    servers and real Gemini on a mock spreadsheet window.
- **S3.2 (Circle & Ask)** — brief [SCREEN_COACH_S3_2.md](SCREEN_COACH_S3_2.md), decision 11:
  - **Desktop** (`circle.rs`: the session, tracker, draw mode, marks, capture; `circle_answer.rs`:
    the request, streamed steps, playback, the toast and saving; pure: `marks.rs` classification
    and targets, `pointer.rs`, `circle_steps.rs` playback timing, `circle_protocol.rs`,
    `raster.rs` marks on the focus image). Three new overlay pages: `pointer`, `draw-overlay`
    (mouse, pen, touch, the select-question box, keyboard drawing) and `circle-card` (ask bar,
    captions with Pause · Repeat · Next · Stop, the save toast). The S3 ink overlay draws one step
    at a time (`step` in its requests). Left Ctrl + left Alt are polled (no hooks); Ctrl+Alt+D
    toggles; Ctrl+Alt+. / Ctrl+Alt+, and Esc are registered only during a session.
  - **Server:** `/api/screen/circle-ask` (prompt `circle-ask.v1`, two images, steps streamed and
    checked in code: ink within 120 px of the marks, 25 words, the safety check, abort on an unsafe
    step), `/api/screen/read-question` (`read-question.v1`, handwriting), `/api/screen/entries/
append` (follow-ups). Rate limits `circleAsk*` (10/min, 150/day, 1,500/month) and
    `readQuestion*` (10/min, 100/day).
  - **Entries** are clips with `kind = 'entry'` (migration `clip_entries`: session, student
    strokes, the turns, `strokeSteps`, `revision` for compare-and-set appends). The notebook puts
    them on the day's "From screen" page (`Page.fromScreenDay`), the note under the picture
    (`EntryNotes.tsx`), Replay a step at a time (`entry-replay.ts`), and their text in
    `note_lines`.
  - Consent version 4 (the settings page explains the pointer, drawing and auto-saving); its
    Circle & Ask section has the pointer, saving and silent-mode settings.
  - **The `clip_entries` migration is not applied to the hosted project yet.**
  - **To verify by hand:** the pointer at 150 % on two monitors, drawing with mouse and pen, normal
    clicks while the keys aren't held, the overlays absent from a Teams share, AltGr typing never
    drawing, scrolling fading the marks, a v–t graph on YouTube (Enter → steps with ink before
    words), the toast (Undo leaves nothing; Open shows the entry), "Select question on screen"
    on handwriting, and silent mode with only the keyboard. Not done (left for S5, decision 11):
    course context in the answer, and evidence from the follow-up question.
- **Next:** S5 (learner integration: skills from walkthroughs, evidence, FSRS re-checks).
  Notes Check (S3.5) N1–N5 are built; see below.

**Notes Check (S3.5)** — brief and binding Decisions (1–39) in
[SCREEN_COACH_NOTES_CHECK.md](SCREEN_COACH_NOTES_CHECK.md). **N1–N5 built** (2026-10-23). The
whole flow: **lines** (N1) → **retrieval** (N2) → **comparison** (N3) → **marks** on the screen
and in the notebook (N4) → **follow-ups** that feed the learner model (N5).

- **N2, retrieval** (`backend/src/mew_api/notes/retrieval.py`, migration `note_search`): exact
  pgvector search plus Postgres full-text search, fused by RRF, ±3 neighbouring lines, and pages
  kept when they score at least 0.4 of the best one. A clip is never compared with itself.
  `test_notes_retrieval.py` includes the eval gate (98% of cases find every expected line).
- **N3, comparison** (`frontend/src/server/notes-check/`):
  - The steps: prompt v3 (short line ids) → a validation layer in code (`notes-validate.ts`) →
    SymPy for maths (it can clear a note, never accuse one) → a second opinion on differences →
    speech rebuilt from the final findings.
  - Checks and findings are stored in `notes_checks` / `notes_findings` (migration
    `notes_checks`).
  - Eval: `pnpm eval:notes`, 62 cases, cached in `frontend/evals/.cache`; results are in
    decision 25.
- **N4, marks:**
  - Desktop: Ctrl+Alt+N (consent v3) sends only redacted OCR text blocks. Marks are drawn as
    overlay actions, beside a Notes Check panel (`notes_check.rs`, `notes_marks.rs`,
    `overlay-src/notes-panel.ts`).
  - Notebook: a DOM marks layer (`NotesMarks.tsx`), `NotesCheckPanel.tsx`, and "Check against my
    notes" on a clip.
- **N5, follow-ups** (`server/notes-check/resolve.ts`, `features/notes/follow-up.ts`,
  `FindingCard.tsx`):
  - The student can answer, say "My note is right", tap "Tell me" (explained automatically after
    two misses), Dismiss, or tap "Add it" on a gap (a heading in tutor ink, then "Check what I
    wrote").
  - Editing a line re-checks it quietly.
  - Open findings come back after a reload.
  - Outcomes become learner-model evidence (`recordAttempt`, source `notes_check`; migration
    `notes_resolution`).
- Rate limits: `notesCheck*` (6/min; `NOTES_CHECKS_PER_DAY`, default 60) and `notesResolve*`
  (20/min, 300/day).
- **Not applied to the hosted project yet:** migrations `note_lines`, `note_search`,
  `notes_checks`, `notes_resolution` (the owner's go is needed).
- **To verify by hand:** a real lecture video in the desktop app (Ctrl+Alt+N, the panel, marks
  beside the right text, "Open in notebook").
- **Needs billing:** embeddings and evals hit the Gemini free tier's 1,000 embedded texts a day.

**N1 details:**

- Every notebook line's recognised text is kept with its page (Dexie v3 `noteLines`) and, when the
  `notes_index` setting is on (default), synced to Supabase `note_lines` through one RPC
  (`sync_note_page`, RLS as the student), which also mirrors notebook and page metadata (never
  strokes).
- Line ids last across edits (`assignLineIds` in `packages/ink`); `content_hash` is stroke ids +
  point counts, so a moved line isn't re-recognised. A line that changed and isn't re-read yet is
  withdrawn from the server, so stale text can't be compared.
- Cost: the tutor's own pen-pause recognition is reused (same cache and in-flight request);
  never-read lines go through `/api/recognize/batch` (8 per call, one batch per 15 s, only while
  the student and tutor are idle); only lines whose text changed are embedded again.
- Recognition now returns `confidence` (prompt `recognition.v2`; the Interactions API has no
  logprobs); blank → 0.
- Client: `frontend/src/features/notes/` (planner, sync plan, indexer, backfill; pure parts tested
  without a browser). Server: `backend/src/mew_api/notes/`, `routes/notes.py`; Next routes
  `/api/notes/pages/[pageId]/lines` and `/api/recognize/batch` (new rate rules).
- **The `note_lines` migration is not applied to the hosted project yet** (needs the owner's go;
  then check the RPC's array/jsonb arguments through PostgREST for real).

Tests (after S3.2): **1,081 unit tests** (frontend 386, backend 271, ink 134, shared 182,
database 91, desktop overlays 17), **151 Rust tests** (+5 real-Windows ones; clippy clean) and
**59 Playwright tests**.

Tests (after S4): **1,021 unit tests** (frontend 362, backend 257, ink 134, shared 172, database
87, desktop overlays 9), **126 Rust tests** (+5 real-Windows ones; clippy clean) and
**54 Playwright tests**.

Tests (after Notes Check N5): **940 unit tests** (frontend 336, backend 240, ink 134, shared 142,
database 81, desktop overlays 7), **116 Rust tests** (+4 real-Windows ones; clippy clean) and
**51 Playwright tests**.

Tests (after Notes Check N1): **806 unit tests** (frontend 290, backend 185, ink 132, shared 123,
database 69, desktop overlays 7), the same Rust tests, and **46 Playwright tests** (`notes.spec.ts`
measured an edited line on the server 1.6 s after the pen stopped).

Tests (after S3): **712 unit tests** (frontend 254, backend 161, ink 123, shared 113, database 54,
desktop overlays 7), **106 Rust tests** (+4 real-Windows ones) and **44 Playwright tests**.

Before Screen Coach: **531 unit tests** (frontend 203, backend 114, ink 108, shared 68, database 38), **5 Rust
tests** (desktop) and **38 Playwright tests**. `pnpm check`, the Playwright suite, the
production build, `cargo test` / `cargo clippy -D warnings` and the Windows installer build
all pass.

Real-API checks (2026-10-17, owner's keys): the gate (`eval:mew` 32/32, both M2 acceptance
phrases), the tutor's response schema, course ingestion (Gemini embeddings, concept graph,
lessons) and `eval:course` (answers cite the right page, 2/2). 2026-10-18: `eval:quiz` (the
quiz grader) 7/7 on Flash-Lite; on Flash every case but the injection one passed before 503s
and the free tier's 20/day quota stopped the run. §9 lists what blocked the rest.

**Git:** M4–M7 are commit `701321e` on `feat/m4-m7-ink-checks-visuals-courses`, cut from
`chore/frontend-backend-layout` (M0–M3 + the folder split). M8 is uncommitted on top of it
(suggested branch `feat/m8-learner-model`). M8 was then committed as `17680fb` on
`feat/m8-learner-model` (plus `2f04cbb`, ONBOARDING.md); M9 and M10 are uncommitted on top
(suggested branch `feat/m9-m10-desktop-mew-v2`). Check `git log` / `git branch -a` for what has
been merged into `main`.

## 3. Layout

```
frontend/                     Next.js 16 app (UI + its /api routes)
  src/proxy.ts                Clerk middleware + nonce CSP (or "local mode", see §4)
  src/server/                 server-only: env, http (origin checks, readJson, readForm),
                              http-error, rate-limit, gemini (schema pruning, §4), mew-gate,
                              tutor, elevenlabs, png, csp, api-client (→ FastAPI),
                              user-api (calls FastAPI as the current user; courses.ts wraps
                              it), voices (allowlist), telemetry (latency), mew-log (opt-in
                              cache + logging decisions)
  src/app/api/                health, mew, stt/token, tutor (NDJSON), tts, recognize,
                              check/math (→ SymPy), courses/** (→ FastAPI; incl. progress,
                              attempts, concepts/[id]/explored), review, quiz/grade, settings,
                              voices, telemetry, mew/events (+ [id], export)
  src/app/(app)/              notebook, courses, courses/[id], courses/[id]/concepts/[conceptId],
                              review, settings, teach; layout.tsx mounts DesktopBridge
  src/app/manifest.ts, error.tsx, global-error.tsx   PWA manifest; error pages
  src/features/notebook/      canvas (renderer, input, tools), engine (PageEngine: undo,
                              IndexedDB, tab sync, addTutorStrokes), repository (Dexie),
                              visibility (hidden tutor ink), Sidebar, Toolbar
  src/features/tutor/         controller (turns, barge-in, checks, course context), ink.ts
                              (TutorInk: plans and animates board actions), context.ts, store
  src/features/check/         WorkChecker (router: SymPy / chemistry / code), lines.ts,
                              code-runner.ts (Pyodide worker client)
  src/features/courses/       api client, course list + upload, ScopeReview, StudyPlan (+ ExamPlanView,
                              StatusChip), LessonView (+ PracticeCard), ReviewApp (/review)
  src/features/quiz/          QuizSession ("Quiz me": pick, ask, grade, record), QuizCard, store
  src/server/learner.ts       FSRS (ts-fsrs, server-only), ratings from evidence, progress
  src/server/quiz.ts          grading with the tutor model
  src/features/mew/           gate (v1), local-gate (v2: CascadeMewGate, WorkerClassifier),
                              triggers, controller (pen-pause quick checks, skip hook), session
  src/features/settings/      store (server-saved, debounced, race-safe), SettingsApp, controls
  src/features/onboarding/    first-run introduction (native <dialog>)
  src/features/telemetry/     LatencyReporter (turn timings → /api/telemetry)
  src/features/desktop/       bridge (isDesktop, review reminders), DesktopBridge
  src/features/teach/         Teach Mew (labelling kept gate decisions)
  src/features/voice/         microphone, Scribe client, voice session
  public/workers/             code-runner.mjs (Pyodide), mew-gate.mjs (Mew v2 classifier); their
                              own CSP (next.config.ts). vendor/ (transformers.js + ONNX Runtime,
                              copied) and models/ (a trained model) are gitignored
  public/pyodide/             copied from node_modules by scripts/copy-pyodide.mjs (gitignored)
  public/icons/               PWA icons (generated from desktop/icon.svg)
  scripts/copy-*.mjs          run before dev/build (and before the e2e server)
  e2e/                        Playwright: notebook, voice, tutor, ink, check, visuals, courses,
                              learner, app (M9), mew-v2 (M10); fixtures.ts resets settings
  e2e/helpers/pdf.ts          tiny PDF writer for tests
  evals/                      eval:mew, eval:tutor, eval:course (real APIs; skip without keys)
backend/src/mew_api/          FastAPI (see backend/README.md)
  checker/                    SymPy step checker (latex.py, steps.py) + sandbox.py (process pool)
  courses/                    pdf, chunking, embeddings, llm, prompts, concepts, lessons,
                              store (memory) + supabase_store, ingest
  learner/                    models (attempts, FSRS card shape, due cards)
  profiles/                   settings models and stores (memory, Supabase)
  mew_events/                 kept gate decisions: models and stores
  dataset/                    Mew v2 features (mirror of mewFeatureText) and the exporter CLI
  supabase_rest.py            PostgREST plumbing shared by every Supabase store
  routes/                     health, me, check, courses, learner, settings, mew_events
backend/supabase/             migrations (core, stroke tool, courses, learner, settings) + RLS
                              tests on PGlite
desktop/                      Tauri v2 (Windows): src-tauri/src/{lib,origin,reminders}.rs
ml/                           train.py, train_mew_gate.ipynb, pyproject (own uv env)
packages/shared/              zod schemas (notebook, mew, tutor, voice, check, course, learner,
                              quiz, settings, telemetry, mew-events), mew-features (v2 input
                              text + golden cases), reconcileMarks, chemistry balance, mew-policy, learner
                              logic (status, quiz order, exam plan), prompts (mew, tutor v5,
                              checker, quiz-grade v1)
packages/ink/                 geometry, spatial index, segmentation, history, outline, lasso,
                              viewport, crop, and tutor/: glyphs (Hershey JSON + NOTICE),
                              typeset (text, LaTeX), placement, handwriting, inkify, board
                              (planner), actions, visuals (expr, plot, graph, shapes, rough)
scripts/                      health.ts, build-glyphs.ts (regenerates the glyph table)
```

## 4. Decisions and deviations from the brief (and why)

Earlier decisions (M0–M3) still hold:

- **Auth: Clerk instead of Supabase Auth** (owner's choice). Supabase trusts Clerk through
  third-party auth; RLS uses `auth.jwt()->>'sub'`; user ids are `text`.
- **Local mode:** without Clerk keys, development runs signed-out with browser-only data. In
  production a missing key returns **503** (fails closed).
- **FastAPI is internal** (Render, Docker, non-root): only the Next server calls it, with
  `X-Internal-Secret` plus the user's Clerk JWT (or, in development only, a local-user marker).
- **Gemini** via `@google/genai` / `google-genai` **Interactions API**, `store: false` always,
  JSON-schema output validated with zod/Pydantic, retry once, then degrade.
- **ElevenLabs** without SDKs: single-use STT tokens, `/api/tts` PCM proxy. Not the Agents product.
- **Early speech:** `speech` is the first field of `TutorResponse` and is spoken before the
  board actions finish streaming.
- **Rate limiting is in memory** (one instance). Swap for a shared store before scaling out.
- **Toolchain pins:** TypeScript ~6.0, ESLint 9; pnpm `minimumReleaseAge` 14 days (Next and
  Clerk exempt); GitHub Actions pinned to SHAs. New Python deps were also chosen ≥ 14 days old.
- **Cache Components are off** (the nonce CSP needs dynamic rendering).

Added in M4–M7:

- **Glyphs: Hershey fonts** (Simplex Roman, Greek, maths symbols) converted by
  `scripts/build-glyphs.ts` from `kamalmostafa/hershey-fonts@1356bf2` into our own JSON. The
  licence requires its acknowledgements to ship with the data:
  `packages/ink/src/tutor/glyphs/NOTICE.md`. ≈ ⇌ ⇒ ↔ are drawn by the script.
- **LaTeX → ink is our own small parser** (no KaTeX): depth/size capped, falls back to text.
- **Tutor ink** is planned in `packages/ink` (framework-free, unit-tested) and animated by
  `TutorInk` on the canvas live layer. A turn's ink is one undo step (`addTutorStrokes`, change
  type `"tutor"`, so Mew doesn't treat it as the student writing). Barge-in pauses the ink; it
  resumes after 1.5 s of quiet, moving any unwritten part the student has written over.
- **Placement** stays inside a "safe area" the canvas reports (the visible page minus the
  floating toolbar, page nav and mascot). Diagrams have a minimum size (`visualSize`).
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
- **Gemini schema rules** (verified against the API, regression-tested on both sides):
  `oneOf` must become `anyOf` (zod's discriminated unions; dropping it had silently stripped
  the board actions from the tutor's schema), and **no `minItems`/`maxItems`** (with unions or
  nested arrays Gemini answers 400 "invalid argument"). zod/Pydantic still enforce the bounds;
  Pydantic trims over-long model text and lists instead of rejecting a useful answer. Fields
  the model must always fill have no defaults (defaults make the model skip them).
- **Backend prompts** (concept graph, lesson, OCR) live in
  `backend/src/mew_api/courses/prompts.py`, versioned like the TS ones (Python can't import the
  TS modules). Frontend prompts are TS modules in `packages/shared/src/prompts/`.
- **Playwright** starts its own Next (:3100, `.next-e2e`) and API (:8100) with a throwaway
  internal secret and no model/Clerk keys, and runs one test at a time (timing-based tests).
  The API's local store is shared by all specs in a run: scope assertions to your own course.

Added in M8:

- **Attempts are the record; cards are the schedule.** `attempts` is append-only (no update
  grant; id and timestamp aren't insertable, so no backdating). `review_cards` holds one ts-fsrs
  card per concept (`unique (concept_id, user_id)`, keyed with the user so a duplicate can't
  reveal someone else's card). Both reference `concepts (id, course_id, user_id)`, a new unique
  key, so an attempt can't name a concept of another course or user.
- **FSRS runs on the Next server only** (`server/learner.ts`): ts-fsrs 5 patches four deprecated
  helpers onto `Date.prototype` when imported, so it stays out of the browser bundle. FastAPI
  validates the card it's sent (`learner/models.py`) and stores it. No fuzz, no minute-level
  learning steps (concepts, not flashcards): wrong → 1 day, with hint → 2, on your own → 3, then
  growing. Concurrent answers on one concept (two tabs) can lose one card update; the attempt
  log is still complete.
- **Evidence → rating:** independent correct = Good, with hint = Hard, after explanation or wrong
  = Again. Only independent answers grow mastery meaningfully (brief §9).
- **Status** (`conceptStatus` in shared) comes from the attempt log plus the card's due date:
  the latest answer decides ("checked" needs it independent); a slip after a success, or a due
  review, is "revisit". Opening a lesson creates the card ("explored", due now, so it shows on
  Review as new).
- **Quiz me** records one attempt per question with its final outcome: a wrong first try, the
  hint button or asking the tutor makes a later correct answer "with hint"; "Show answer" makes
  it "after explanation"; skipping an attempted question records it as not known. Answer = the
  student lines written after the question was asked, plus speech after it was read out (tutor
  echo filtered). During a quiz, pen pauses are skipped (no quiet ticks or remarks: test
  conditions), and "is this right?" (gate `check_work` from speech or a tap) goes to the grader.
  The tutor gets the question (never the model answer) as `quiz` in its request (prompt v5).
- **Grading** (`/api/quiz/grade`) uses `GEMINI_TUTOR_MODEL` (rubric checker, brief §7); without a
  model the student self-grades against the model answer. Lessons without practice questions
  (no model) fall back to a recall question built from the concept summary.
- **Exam planning** (`planExam` in shared): revisit first, then unchecked concepts in course order
  spread over the days left; checked concepts come back on their review day if it's before the
  exam; with 3+ days left the eve is a final review. Calendar maths is done on dates (no DST).

Added in M9:

- **Desktop = Windows first, with Tauri.** The owner asked for Windows (macOS later). The window
  shows the remote web app (`MEW_APP_URL`, default :3000), so keys stay on the server. Beyond the
  wrapper it adds a global hotkey (Ctrl+Shift+M → `mew:summon` DOM event via `eval`), a tray, and
  review reminders. The remote origin gets exactly one permission (`allow-notify-due`, a runtime
  capability scoped to the app origin); `notify_due` sanitises and rate-limits (30 min) in Rust.
  Navigation is limited to the app origin and Clerk. Notifications only show for installed apps.
- **PWA too** (manifest + icons; no service worker: the nonce CSP and offline caching don't mix
  well, and notes are already offline in IndexedDB).
- **Settings live in `profiles.settings`** (new migration constrains the keys), read and written
  through FastAPI (`/v1/me/settings`; memory store in local mode). The client store applies
  changes at once, **debounces saves (300 ms)**, never lets an older reply undo a newer change,
  never lets a slow first load overwrite edits, and flushes pending saves on `pagehide` with
  `keepalive`. These were real bugs found by the e2e tests.
- **Voice choice** is an allowlist (`ELEVENLABS_VOICES`), resolved on the server: an arbitrary
  voice id never reaches the ElevenLabs URL. A 402 (Voice Library voice on a free plan) becomes
  a message the student can act on.
- **Gemini cooldown** (`server/gemini.ts`): after a 429 or 503, calls to that model fail fast
  (`ModelBusyError`) until the retry time (capped at 15 min; 503 → 20 s). The gate falls back at
  once, the tutor says it's busy, recognition answers 429 + Retry-After and the client waits.
- **Latency telemetry**: timings only (never content), batched by the client, kept in memory per
  user (one instance, like the rate limiter) and logged as `[latency] {...}` lines without user
  ids. Settings shows median / 95th percentile per stage against the brief's targets.
- **Onboarding** is a native `<dialog>` (focus trap, Escape); `onboarded` is a setting.

Added in M10:

- **Logging only with opt-in, checked twice**: the API reads the profile setting, and RLS on
  `mew_events` refuses inserts without it. Next caches the opt-in for 60 s and updates the cache
  whenever settings are read or changed through it, so opting out applies to the next decision.
  Logging runs in `after()` (never delays the gate) and never throws.
- **One feature format, two implementations**: `mewFeatureText` (TS) and `mew_feature_text`
  (Python) build the classifier's text; both are tested against `mew-features.cases.json`
  (including whitespace and emoji/code-point edge cases). Features are versioned; a model trained
  on another version is refused by the browser.
- **Dataset export** (`python -m mew_api.dataset`) only includes students _still_ opted in,
  resolves conflicting labels by majority (ties dropped), splits by a hash of the text.
- **Training** (`ml/`, own uv env, `exclude-newer` 14 days): plain PyTorch loop (no
  accelerate/optimum), legacy ONNX exporter, onnxruntime dynamic int8. The trust threshold is
  chosen on the validation split (95 % precision) and shipped in `mew.json`.
- **In the browser**: transformers.js 4.3 (self-contained `transformers.min.js`) and ONNX
  Runtime's _asyncify_ WebAssembly build, self-hosted under `/workers/vendor/` (copied before
  dev/build), single-threaded (no SharedArrayBuffer), remote models disabled. The cascade never
  waits for the model to load (v1 decides until it's ready); the worker warms up (one dummy
  run) before saying ready; answers slower than 250 ms go to v1.

## 5. Security model (keep these invariants)

- Every POST route: `assertSameOrigin` → `requireUserId` → `enforceRateLimit` → `readJson` /
  `readForm` with a byte cap. GET routes use `assertNotCrossSite` (browsers send no Origin on
  same-origin GETs). Errors go through `handle()`; API failures map to safe messages.
- Images from the client are verified PNGs (`png.ts`); uploads are verified PDFs by their bytes
  (`%PDF-`), capped at 15 MB in Next (streaming) and again in FastAPI.
- Untrusted parsing runs out of process: SymPy (checker pool), PDFs (ingest pool), student code
  (Pyodide worker, terminated on timeout).
- Strict nonce CSP; `connect-src` only allows self, ElevenLabs' socket and Supabase.
  `/workers/*` and `/pyodide/*` skip the proxy and get
  `default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'`.
- The database denies by default: RLS on every table, column-level grants, composite foreign
  keys, `match_chunks` is `SECURITY INVOKER`, and storage objects are scoped to `<user id>/` in
  a private bucket. `service_role` keeps Supabase's default grants (ingestion needs them).
- Model output is always schema-validated. Speech, handwriting, images and course material are
  data, never instructions (stated in every prompt).
- Never put a JWT-shaped literal in source: gitleaks flags it (see `.gitleaksignore`).
- The desktop shell grants the web origin one command only (`notify_due`); add any new
  native feature in Rust, triggered by the shell, before considering another permission.
- Students' words leave the notebook for training only with opt-in; datasets (`ml/data`) are
  gitignored and must be handled like the database.

## 6. Environment

One file: **`.env.local` at the repo root** (gitignored), read by both frontend and backend.
Template: `.env.example` (every variable is commented there). As of 2026-10-22 every key is set,
including `SUPABASE_SECRET_KEY` (a new-style `sb_secret_` key, verified against the project).
The owner switched `GEMINI_TUTOR_MODEL` to Flash-Lite and `ELEVENLABS_VOICE_ID` to George
(free-plan voice) on 2026-10-18.

Before courses work when signed in (Clerk mode):

1. ✅ Done 2026-10-22: the five migrations in `backend/supabase/migrations/` were applied to the
   hosted project (`gvwynloprjomqqovpoem`) through the Supabase connector, in order. Results:
   - 14 tables, RLS on every one, no `anon` grants, and the private `course-sources` bucket with
     its three storage policies.
   - Supabase's security advisor reports nothing.
   - A live cross-user test (rolled back) showed user B can neither read nor update user A's
     course.
   - The performance advisor's `auth_rls_initplan` warnings are a false positive: the policies
     already use `(select auth.jwt() ->> 'sub')`, and the query plan shows a one-off InitPlan
     using the index.
   - New migrations must be applied the same way, after the owner confirms.
2. ✅ Done 2026-10-22 (by the owner): Supabase third-party auth trusts Clerk
   (`still-mosquito-3338.clerk.accounts.dev`, the development instance). The owner confirmed
   `/status` is green (FastAPI and Supabase both accept the Clerk session). A production Clerk
   instance needs adding too.
3. ✅ `SUPABASE_SECRET_KEY` is set locally (API service only). Render needs it too.

Render also needs `GEMINI_API_KEY`, `NEXT_PUBLIC_SUPABASE_URL`,
`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` and `SUPABASE_SECRET_KEY` (see `render.yaml`), and more
than the free plan's 512 MB of RAM.

## 7. Commands

```sh
npm run dev            # frontend :3000 + backend :8000 (same as pnpm dev)
pnpm health            # both services + frontend→backend link
pnpm check             # prettier, eslint, tsc, all unit tests (incl. backend via uv)
E2E_BASE_URL=http://localhost:3100 pnpm --filter @mew/frontend e2e
                       # Playwright starts its own Next (:3100, .next-e2e) and API (:8100)
NEXT_DIST_DIR=.next-build pnpm --filter @mew/frontend build   # without touching your .next
pnpm eval:mew / eval:tutor / eval:course / eval:quiz   # real APIs (skip without keys)
EVAL_RPM=0 pnpm eval:mew                    # no pacing (paid tier)
GEMINI_TUTOR_MODEL=gemini-3.5-flash-lite pnpm eval:course   # override a model for one run
cd backend && uv run --frozen pytest | ruff check . | mypy
pnpm tsx scripts/build-glyphs.ts <dir with futural.jhf, greeks.jhf, mathupp.jhf>
cd desktop && pnpm app | pnpm bundle             # desktop app (Rust; MEW_APP_URL)
cd desktop/src-tauri && cargo test && cargo clippy --all-targets -- -D warnings
cd backend && uv run python -m mew_api.dataset --out ../ml/data --seed ../frontend/evals/mew.cases.json
cd ml && uv sync && uv run python train.py --data data --export ../frontend/public/workers/models/mew-gate
```

## 8. Pitfalls on this machine (Windows, Git Bash)

- **Python run from a Bash heredoc turns `\b` in a replacement string into a backspace byte**
  (it happened to a regex in `gemini.ts`). Make code edits with the Edit tool, or a script file.
- **Bash heredocs and `node -e` mangle backslashes and quotes** (`\\.` became `\.`; a `’`
  escape became the literal character; apostrophes end a single-quoted script). Write source
  with the file tool; in Python tests write `chr(0x2019)`. `proxy.test.ts` guards the proxy
  matcher regex.
- **One `next dev` per build folder.** Next refuses a second dev server on `.next` ("Another
  next dev server is already running"). Playwright uses `NEXT_DIST_DIR=.next-e2e` and port 3100,
  so it runs beside your own dev server; set `E2E_BASE_URL` accordingly.
- **This machine's browsers refuse URLs ending in `.zip` or `.bin`** (blocked before the request
  leaves the browser, status 204; both Edge and Chromium; no proxy or policy found). Hence the
  Pyodide stdlib is served as `.dat`.
- Stopping a background shell doesn't kill the servers it started. Find and kill them with
  PowerShell: `Get-CimInstance Win32_Process | ? { $_.CommandLine -match 'GitHub\\mew' -and
$_.CommandLine -match 'next|uvicorn|spawn_main' }`, then confirm ports 3000, 3100, 8000 and
  8100 are free. The SymPy/PDF pools spawn Python children; check for orphans the same way.
- `uv run python -I` ignores `PYTHON*` env vars, and the console is cp1252: print non-ASCII with
  `sys.stdout.reconfigure(encoding="utf-8")` first.
- Gemini free tier: 15 requests/min on Flash-Lite (`eval:mew` paces itself at 14/min); Flash is
  5/min and 20/day (`eval:quiz` paces at `EVAL_RPM`, default 5).
- Moving folders breaks `node_modules` and `.venv`; delete both and reinstall.
- Rust is installed with rustup (stable MSVC, `%USERPROFILE%\.cargo\bin`); Git Bash may need
  `export PATH="$HOME/.cargo/bin:$PATH"`. The first Tauri build compiles ~400 crates.
- **The owner may be using this machine while you work**: a launched desktop window appears on
  their screen. Don't send synthetic keystrokes (the hotkey) to it.
- In `next dev`, `uncaughtException: Error: aborted` is logged when a browser disconnects in the
  middle of sending a request body (e.g. Playwright closing a page during a keepalive upload).
  Nothing fails; it isn't a handler error.
- After editing `.env.local`, restart the dev servers.
- React's compiler lint rules are on: no ref reads or impure calls during render, and no
  synchronous `setState` in effects (set state from promise callbacks).

## 9. Known limitations / open items

- **Gemini quota:** on the owner's free-tier project, `gemini-3.8-flash` (the default tutor
  model) took ~50 s per call or timed out, and other Flash models returned 429 "quota
  exceeded"; only Flash-Lite responded. `eval:tutor` can't pass until billing is enabled (or
  `GEMINI_TUTOR_MODEL` is set to a model with quota). Gate latency is ~0.8 s (brief target
  0.4 s for v1; v2 should fix that).
- **ElevenLabs voice:** Voice Library voices fail with 402 on a free plan; the app now says so.
  George (`JBFqnCBsd6RMkjVDRZzb`) works on the owner's key.
- Course ingestion runs as a FastAPI background task: a restart mid-ingestion leaves the course
  "processing" (no job queue yet). The local store is in memory (lost on API restart).
- Only PDF sources are wired up (`sources.kind` also allows `text` and `topic`: brief §8 step 1).
- Units checking covers `\text{…}` units with SI conversion; inequalities, `\pm` and some
  notations are "unknown" (never guessed). The code checker only reports failures.
- Two tabs editing the same page: last write wins. No cloud sync of strokes yet;
  `tutor_turns` isn't written to Supabase yet.
- Echo handling for the tutor's voice is heuristic (word overlap); headphones are best.
- The conversation drawer isn't built. Library, Mind map, Flowchart and Just practise are still
  "coming soon" in the sidebar.
- **Mew v2 has no real model yet.** The pipeline was run end to end on the 29 seed cases
  (DistilBERT: 40 % validation accuracy, trust threshold 1.0, so it never answers and v1
  decides); a useful model needs a few hundred labelled decisions per label. Warm inference
  with DistilBERT int8 took 93 ms in the browser here, over the brief's 30 ms for v2: try a
  smaller base (e.g. a 4-layer MiniLM/TinyBERT with a tokenizer.json) once data exists.
- **Desktop:** Windows only (no macOS build, signing or auto-update). The hotkey and
  notifications were not exercised automatically (the owner was using the machine); the
  window, sidebar and intro were checked visually. Telemetry is per instance and in memory.
- Quiz grading is the model's judgment against the lesson's answer. Maths answers aren't yet
  settled by SymPy (brief: never trust the model for algebra); e.g. "x = 4/2" for "x = 2" is
  "correct" on Flash but "partly" on Flash-Lite. Next step: when the expected answer and the
  student's line both parse as LaTeX, check equivalence first and let the model only explain.
- Work checked outside a quiz (pen-pause ticks in a course notebook) isn't attributed to
  concepts: retrieval-based attribution was judged too unreliable to count as evidence.
- Lesson practice is self-graded (hint taken → "with hint"); only the notebook quiz is graded.
- Supabase returns at most 1000 rows per request: progress uses a course's latest 1000 attempts.

## 10. Beyond the brief's milestones

Every milestone (M0–M10) is built. Sensible next steps, roughly by value:

- **Collect labels and train a real Mew v2** (ml/README.md), then compare v2 with v1 on
  `evals/mew.cases.json` and on held-out student data. Consider a smaller base model for latency.
- **SymPy for quiz answers** (see §9) and **cloud sync of notebooks** (strokes are local only).
- **macOS desktop build** (microphone usage description and audio-input entitlement), signing,
  auto-update; a "screen context" feature ("explain what I'm reading") would need a careful
  permission design.
- **Shared rate limiting and telemetry** (Redis or similar) before running more than one web
  instance.
- The remaining sidebar study modes (Mind map, Flowchart, Just practise) and the conversation
  drawer (brief §12).

## 11. Recipes

**A new Next API route.** Copy an existing one (`app/api/check/math/route.ts`): `handle()`,
then `assertSameOrigin` (POST) or `assertNotCrossSite` (GET) → `requireUserId` →
`enforceRateLimit` with a rule in `server/rate-limit.ts` → `readJson(schema, maxBytes)`.
Schemas live in `packages/shared`. Add cases to `app/api/routes.test.ts` (cross-origin,
malformed, oversized, upstream failure doesn't leak details).

**A new FastAPI endpoint.** Add a router in `backend/src/mew_api/routes/`, include it under the
`/v1` router in `main.py` (internal secret enforced there). Take `CurrentCaller` for per-user
work; Pydantic models with `extra="forbid"`. Call it from Next through `server/api-client.ts`
(or `server/courses.ts` to act as the user). Test with `TestClient` (see `tests/test_courses.py`).

**A new table.** New file in `backend/supabase/migrations/` (timestamped). Follow the courses
migration: `user_id text default (auth.jwt()->>'sub')`, `unique (id, user_id)`, composite FKs
to the parent, size checks, `revoke all … from anon, authenticated`, explicit grants (columns
for updates), RLS policies per action. Add attack tests (`courses.test.ts` is the template).

**A new board action.** Extend `BoardAction` in `packages/shared/src/tutor.ts` (keep it a
discriminated union; mind §4's schema rules), describe it in the tutor prompt (bump its
version), write a renderer `(action, planner, index) → PlannedAction | reason` in
`packages/ink/src/tutor/` and register it in `ALL_RENDERERS` (`actions.ts`). Use
`planner.place()` for space and `planner.commit()` to ink it. Unit-test it, then an e2e test
that mocks `/api/tutor`.

**A new checker.** Add a branch to `WorkChecker.check()` (`features/check/checker.ts`) that
returns `LineCheck[]` (verdict `unknown` when unsure). Server-side checkers belong in
`backend/src/mew_api/checker/` and run through the sandbox pool.

**A prompt change.** Edit it in `packages/shared/src/prompts/` (or `courses/prompts.py`), bump
its `id`, and run the matching eval (`eval:mew`, `eval:tutor`, `eval:course`) with real keys.

**An e2e test.** Mock model routes with `page.route` (see `e2e/ink.spec.ts`); the API service
is real. Make written lines differ in shape when mocking recognition by image (identical
strokes give identical crops). Fail on CSP violations like the existing specs do.
