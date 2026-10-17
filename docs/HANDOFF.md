# Handoff: state of the build

Context for a new working session. Read this, then [BUILD_BRIEF.md](BUILD_BRIEF.md) (the
product brief), then the root [README.md](../README.md). Last updated 2026-10-17.

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

| Milestone            | Status                                                                           |
| -------------------- | -------------------------------------------------------------------------------- |
| M0 Scaffold          | ✅ Done                                                                          |
| M1 Notebook canvas   | ✅ Done (plus lasso, live sync between tabs, stacked-fraction line segmentation) |
| M2 Voice in + Mew v1 | ✅ Built and tested with mocks. **Not verified on real APIs** (no keys yet).     |
| M3 Tutor + voice out | ✅ Built and tested with mocks. **Not verified on real APIs** (no keys yet).     |
| M4 Ink output        | ⏭ **Next** (needs no API keys)                                                   |
| M5–M10               | Not started                                                                      |

Test counts: 250 unit tests (frontend 116, ink 49, shared 35, backend 32, database 18) and 17
Playwright browser tests. All pass.

Git: `main` holds M0 to M2 (and possibly more, depending on what has been merged). Branches, in
order: `fix/ci-secrets-e2e` → `feat/m3-tutor-voice` → `chore/frontend-backend-layout`. Each was
cut from the previous one. Check `git log` / `git branch -a` for what's merged.

**Real-API verification still owed:** once keys are in `.env.local`, run `pnpm eval:mew` (M2
acceptance phrases) and `pnpm eval:tutor` (M3: median first audio under 2 s), then try the app
by voice.

## 3. Layout

```
frontend/                     Next.js 16 app (UI + its /api routes)
  src/proxy.ts                Clerk middleware + nonce CSP (or "local mode", see §4)
  src/server/                 server-only code: env.ts, http.ts (origin, body limits, errors),
                              rate-limit.ts, gemini.ts, mew-gate.ts, tutor.ts, elevenlabs.ts, png.ts, csp.ts
  src/app/api/                health, mew, stt/token, tutor (NDJSON stream), tts (PCM proxy), recognize
  src/features/notebook/      canvas (renderer, input, tools/{pen,eraser,lasso}), engine.ts (PageEngine:
                              doc + undo + IndexedDB + cross-tab sync), repository.ts (Dexie), export-line.ts
  src/features/voice/         microphone.ts (AudioWorklet), scribe-client.ts, voice-session.ts
  src/features/mew/           triggers.ts, controller.ts, gate.ts, useMewSession.ts (wires everything), UI
  src/features/tutor/         controller.ts (turns, barge-in, echo), pcm-player.ts, recognition.ts,
                              context.ts, store.ts (turns incl. board actions), Caption, TutorDebug
  public/worklets/            pcm-recorder.js + pcm-encoder.js (mic → 16 kHz PCM)
  e2e/                        Playwright specs (notebook, voice, tutor)
  evals/                      eval:mew, eval:tutor (real APIs; skip without keys)
backend/                      FastAPI (Python 3.12 via uv): Clerk JWT verification, internal secret
backend/supabase/             SQL migrations + RLS tests run on PGlite (no Docker needed)
packages/shared/              zod schemas (notebook, mew, tutor/BoardAction, voice), mew-policy, prompts/
packages/ink/                 framework-free: geometry, spatial index, segmentation, lasso, history,
                              outline (perfect-freehand), viewport, crop planning
```

## 4. Decisions and deviations from the brief (and why)

- **Auth: Clerk instead of Supabase Auth** (the owner's choice). Supabase trusts Clerk through
  third-party auth. RLS uses `auth.jwt()->>'sub'`, and user ids are `text`. Clerk app:
  `app_3Knnn27SofjvSah5l6OrFpb6B5V`. Keys aren't set yet.
- **Local mode:** without Clerk keys, development runs signed-out with browser-only data. In
  production a missing key returns **503** (fails closed), so this is never an auth bypass.
- **Backend hosted on Render** (`render.yaml`, Docker, non-root, `/health`). FastAPI is internal:
  only the Next server calls it, with `X-Internal-Secret` plus the user's Clerk JWT. The browser
  never calls it directly.
- **Hosted Supabase**, project `gvwynloprjomqqovpoem`. Migrations are **not applied yet**.
- **Gemini:** `@google/genai` 2.26 **Interactions API** (`client.interactions.create`), with
  `response_format` set to a JSON schema generated from zod (unsupported keywords pruned, `const` →
  `enum`) and `generation_config.thinking_level`. Always `store: false` (student data). Defaults:
  gate `gemini-3.5-flash-lite`, tutor `gemini-3.8-flash`, both overridable by env.
- **ElevenLabs:** STT uses Scribe realtime over our own small WebSocket client (no SDK) with
  single-use tokens from `/api/stt/token`. TTS goes through the `/api/tts` proxy: streaming
  `pcm_24000` from `eleven_flash_v2_5`, played with Web Audio.
- **Early speech:** `TutorResponse` lists `speech` first. The server extracts it from the
  streamed JSON (`partial-json.ts`) and starts TTS before the board actions finish.
- **Prompts are TypeScript modules** in `packages/shared/src/prompts/` (versioned ids), not
  `.md`, so they bundle safely.
- **Rate limiting is in memory** (`rate-limit.ts`, sliding window, character-weighted for TTS).
  That's correct for one instance; swap in a shared store before scaling out.
- **Toolchain pins:** TypeScript **~6.0** (typescript-eslint doesn't support 7) and **ESLint 9**
  (Next's plugins don't support 10). Dependabot is told to ignore those majors and Python ≥ 3.13.
- **Supply chain:** pnpm `minimumReleaseAge` is 14 days, with exemptions for `next`, `@next/*`,
  `eslint-config-next` and `@clerk/*` so security patches apply immediately. `allowBuilds`
  allowlists install scripts (reviewed and denied: `@google/genai`, `protobufjs`). GitHub Actions
  are pinned to commit SHAs.
- **Cache Components are off** in Next: a nonce CSP needs every page rendered dynamically.

## 5. Security model (keep these invariants)

- Every POST route: `assertSameOrigin` → `requireUserId` → `enforceRateLimit` → `readJson(schema,
maxBytes)`. Errors go through `handle()` (no internals leak; a missing env var gives 503).
- Images from the client are verified as real PNGs, at most 2048×2048 (`png.ts`), before reaching
  a model.
- Strict nonce CSP. `connect-src` allows only self, `wss://api.elevenlabs.io` and Supabase.
- The database denies by default: RLS on every table, column-level grants, and composite foreign
  keys so a user can't attach rows to another user's notebook.
- Model output is always schema-validated. Speech, handwriting and images are data, never
  instructions (stated in the prompts).
- Never put a JWT-shaped literal in source: gitleaks flags it (see `.gitleaksignore`).

## 6. Environment

One file: **`.env.local` at the repo root** (gitignored), read by both frontend and backend.
Template: `.env.example`. Set: Supabase URL + publishable key, `INTERNAL_API_SECRET`.
Missing: `GEMINI_API_KEY`, `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`, Clerk keys,
`CLERK_ISSUER`. Never read or print its values; check presence only.

## 7. Commands

```sh
npm run dev            # frontend :3000 + backend :8000 (same as pnpm dev)
pnpm health            # both services + frontend→backend link
pnpm check             # prettier, eslint, tsc, all unit tests (incl. backend via uv)
pnpm --filter @mew/frontend e2e      # Playwright (Edge locally; CI uses E2E_CHANNEL=chromium)
pnpm --filter @mew/frontend build
pnpm eval:mew / pnpm eval:tutor      # real-API acceptance (skip without keys)
cd backend && uv run --frozen pytest | ruff check . | mypy
```

## 8. Pitfalls on this machine (Windows, Git Bash)

- **Bash heredocs swallow backslashes** (`\\.` became `\.`), which once broke the proxy matcher
  regex. Write source files with the file-writing tool, not heredocs. A test
  (`proxy.test.ts`) now guards the matcher.
- Stopping a background shell doesn't kill the servers it started. Find and kill them with
  PowerShell: `Get-CimInstance Win32_Process | ? { $_.CommandLine -match 'GitHub\\mew' -and
$_.CommandLine -match 'next|uvicorn' }`, then confirm ports 3000 and 8000 are free.
- Moving folders breaks `node_modules` (pnpm links with absolute paths) and `.venv`. Delete both
  and reinstall (`pnpm install`, `cd backend && uv sync`).
- After editing `.env.local`, restart the dev servers. Next also hot-reloads; if it shows stale
  route types, delete `frontend/.next`.
- React's compiler lint rules are on: no ref reads or impure calls during render, and no
  synchronous `setState` in effects.

## 9. Known limitations / open items

- Two tabs editing the same page sync live, but there are no merges for simultaneous edits to
  the same stroke (last write wins).
- No cloud sync of strokes yet (local IndexedDB only). `tutor_turns` and `mew_events` aren't
  written to Supabase yet (needs Clerk + migrations).
- Echo handling for the tutor's voice is heuristic (word overlap); headphones are best.
- The conversation drawer and settings screen from the brief aren't built. The settings live in
  the Mew debug panel for now.
- The Next dev indicator overlaps the sidebar corner (dev only).

## 10. Next: M4 (ink output)

Acceptance: _the tutor writes a short equation next to my line, at my writing size, without
overlapping my work._

What already exists:

- `BoardAction` / `TutorResponse` schemas (`packages/shared/src/tutor.ts`). Each tutor turn's
  actions are stored in `useTutor` (`features/tutor/store.ts`); the debug panel shows them.
- Line segmentation gives `Line.id`, matching `targetLineId` in `mark_error` / `mark_correct`,
  plus `bbox` and `currentLine()`.
- `Stroke.author: "tutor"`, `groupId`, and the tutor ink colour (`TUTOR_INK` in `palette.ts`);
  `PageEngine.addStroke`; undo/redo; persistence.
- `SpatialIndex` / `PageDocument.inRegion` for occupancy queries.

To build (suggested in `packages/ink`, framework-free and unit-tested):

1. **Glyph library:** single-stroke Hershey-style paths as JSON (a–z, A–Z, 0–9, punctuation, the
   maths symbols in the brief). Check the font's licence before adding it; it's a dependency
   decision to raise with the owner.
2. **Text layout:** glyphs scaled to the student's median x-height (from recent lines), with
   slight jitter on rotation and baseline.
3. **LaTeX subset → positioned glyphs:** fractions, superscripts, subscripts, roots, Greek
   letters, operators. Fall back to plain text. Must be unit-tested.
4. **Placement engine:** anchor → free rectangle near the active line, using an occupancy grid,
   never overlapping student strokes. Must be unit-tested.
5. **Renderer:** convert to `Stroke`s (`author: "tutor"`, one `groupId` per turn) and animate
   them progressively on the live layer, paced to the TTS. Pause on barge-in. Commit them through
   the engine so they're saved, undoable and erasable. A toggle to hide tutor ink.
6. Wire `TutorController` (response event) → render actions. Add a latency mark for "ink start".
7. Tests: unit tests (layout, LaTeX, placement) plus e2e: mock `/api/tutor` with `write_math`,
   and assert tutor strokes appear near the line, at the student's scale, without overlap.
