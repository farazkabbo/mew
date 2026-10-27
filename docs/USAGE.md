# Neb: what it does, how to start it, how to test it

Neb (code name Mew) is a study app with two parts:

- **The web app**: a handwriting notebook with a voice tutor, courses built from your PDFs, and
  spaced review.
- **The desktop app** (Windows): the same web app in its own window, plus **Screen Coach**, a
  tutor that looks at your screen when you ask, talks back, draws on the screen, coaches you
  through tasks and quizzes you.

Deeper docs: [HANDOFF.md](HANDOFF.md) (status, decisions, security rules),
[SCREEN_COACH.md](SCREEN_COACH.md) (Screen Coach), [NOTEBOOKS_K.md](NOTEBOOKS_K.md) (notebooks),
[../ONBOARDING.md](../ONBOARDING.md) (setting up a new machine).

---

## 1. What the app does

### Web app (http://localhost:3000)

| Page          | What it's for                                                                                                                                                                                         |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **/notebook** | The main workspace. A notebook tree (notebooks → chapters → pages), pen and handwriting, and Mew, the tutor, who listens and helps. Each place has a **Moments** tab of things saved from the screen. |
| **/courses**  | Upload a course PDF. It's split into concepts, each with a lesson, and the tutor and Screen Coach can cite it ("page 12 of your notes").                                                              |
| **/review**   | Everything due: course concepts (with **Quiz me**), a **Quick check** of saved moments and screen quizzes, and **Skills to re-check** from coach mode.                                                |
| **/settings** | Voice, quizzing on saved moments, reminders and other preferences.                                                                                                                                    |

What the tutor does in the notebook:

- Explains, hints and checks your written working step by step (maths checked by SymPy).
- Marks each finished line as you write: a tick, an error with a short note, or a missing step.
- "Just tell me the answer": shows a verified solution, then gives you a similar one to try
  (Show-then-You).
- Draws figures (triangles, molecules, force diagrams) on the page.
- Opens PDFs inside the notebook ("Open in neb") and lets you circle text on them.

### Desktop: Screen Coach (over any Windows app)

The one gesture is **holding left Ctrl + left Alt** while you talk. Let go when you're done.

| Say (while holding Ctrl+Alt)                   | What happens                                                                                                                                                |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Any question ("what does this button do?")     | A spoken answer with violet ink on the screen. When your course covers it, the answer names the course and page.                                            |
| Circle something while holding, then ask       | **Circle & Ask**: an explanation step by step beside what you circled, saved to your notebook automatically (Undo is on the card).                          |
| Double-tap Ctrl+Alt                            | Draw mode, to circle with a mouse or pen.                                                                                                                   |
| "save this" / "save this to Physics chapter 5" | Saves what's on screen to the notebook, or to the place you named.                                                                                          |
| "show that again"                              | Puts the last ink back after you scrolled or moved the window.                                                                                              |
| "check my notes"                               | **Notes Check**: compares the screen with your notes and marks anything missing or different.                                                               |
| "teach me how to make a pivot table"           | **Coach mode**: a guided walkthrough, one step at a time. Say "done" after each step or "I'm stuck" for a hint. A pill shows your progress and has buttons. |
| "let me try pivot tables on my own"            | A **solo re-check** of a skill learned before: no guidance, checked at the end. Done with no hint, it counts as mastered.                                   |
| "quiz me on this"                              | 1–3 questions about the screen on a quiz card. Answer by voice (hold Ctrl+Alt again), by typing or by tapping a choice; "skip", "next" and "stop" work too. |
| "Neb, pause"                                   | Pauses Screen Coach: nothing is captured until you resume it from the tray.                                                                                 |

How it feeds your review:

- **A finished walkthrough becomes a skill.** Neb says when it will ask you to try it alone
  (usually a few days later); it appears under **Review → Skills to re-check**, with a desktop
  reminder at most twice a day.
- **Quiz questions and saved moments** come back the next day in **Review → Quick check** (at
  most 15 new cards a day; quiz cards say "From your screen: <window title>").

### Privacy, in short

- Screenshots are captured only when you hold the keys or ask, redacted on your PC first
  (cards, codes, emails, blocked apps, password fields), and **never stored**. Only something you
  choose to save is kept, as a clip in your notebook.
- Pausing stops all capture. Screen Coach's own windows are hidden from screen captures and
  screen sharing.
- Answer keys stay on the server; the desktop app never sees them.

---

## 2. How to start it

### Prerequisites

Node 22+, pnpm 12.14.0, uv, git. For the desktop app also Rust (stable, MSVC) and the Visual
Studio C++ Build Tools. See [../ONBOARDING.md](../ONBOARDING.md) to install them.

### One-time setup (from the repo root)

```sh
pnpm install
cd backend && uv sync && cd ..
cp .env.example .env.local   # only on a new machine; then fill it in (see .env.example)
```

`.env.local` (repo root, gitignored) is the only env file; the web app and the API both read it.
With just `INTERNAL_API_SECRET` set the app runs in **local mode** (no sign-in, data kept
locally). Add the Gemini, ElevenLabs, Clerk and Supabase keys for the full app.

### Database (signed-in mode only)

Every migration in `backend/supabase/migrations/` must be applied to the Supabase project, in
order. The latest two, `20261108000000_skills.sql` and `20261109000000_screen_quiz.sql`, are run
by pasting them into Supabase → SQL Editor (skills first).

### Every time

| What                          | Command                                            | Where                                           |
| ----------------------------- | -------------------------------------------------- | ----------------------------------------------- |
| Web app + API                 | `pnpm dev`                                         | http://localhost:3000 and http://127.0.0.1:8000 |
| Check both are healthy        | `pnpm health` (in a second terminal)               |                                                 |
| Desktop app (Neb for Windows) | `cd desktop && pnpm app` (with `pnpm dev` running) | its own window and a tray icon                  |

Restart the dev servers after editing `.env.local`.

### Turning on Screen Coach (once, in the desktop app)

1. Right-click the Neb tray icon → **Screen Coach settings**.
2. Turn it on and accept the privacy notice.
3. Click **Connect** and approve the device in the Neb window that opens.
4. Hold left Ctrl + left Alt and ask something. The tray menu pauses it or stops a walkthrough.

---

## 3. How to test it

### Everything automatic (before every commit)

```sh
pnpm check
```

Formatting, lint, type checks and every unit test: frontend, shared packages, ink, desktop overlay
pages, the database (RLS on PGlite) and the backend (pytest, through uv).

### Piece by piece

```sh
# Backend (FastAPI)
cd backend && uv run --frozen pytest && uv run ruff check . && uv run mypy src

# Desktop (Rust)
cd desktop/src-tauri && cargo fmt --check && cargo test && cargo clippy --all-targets -- -D warnings

# Desktop overlay pages (TypeScript)
cd desktop && pnpm typecheck && pnpm lint && pnpm test

# One frontend test file
pnpm --filter @mew/frontend exec vitest run src/server/screen-quiz.test.ts
```

### End-to-end (Playwright)

Playwright starts its own web app (:3100) and API (:8100) in local mode with no keys, so it
spends nothing. Stop nothing else: it doesn't touch a `pnpm dev` on :3000.

```sh
E2E_BASE_URL=http://localhost:3100 pnpm --filter @mew/frontend e2e
# one spec:
E2E_BASE_URL=http://localhost:3100 pnpm --filter @mew/frontend exec playwright test screen-learning
```

It uses Microsoft Edge by default; without Edge run
`pnpm --filter @mew/frontend exec playwright install chromium` once and add `E2E_CHANNEL=chromium`.
In PowerShell set the variables first: `$env:E2E_BASE_URL="http://localhost:3100"`.
`notes.spec.ts` depends on real timing and can fail once in a full run; rerun it alone.

### Model evals (real APIs, need keys)

```sh
pnpm eval:mew      # when the tutor should speak
pnpm eval:tutor    # tutor replies
pnpm eval:course   # course concepts and lessons
pnpm eval:quiz     # quiz grading
```

### By hand (things automated tests can't cover)

Run `pnpm dev` and the desktop app, signed in and connected, then:

1. **Ask:** in any app, hold Ctrl+Alt, ask "what does this button do?". You hear an answer
   within about 2 seconds and see ink beside the button.
2. **Circle & Ask:** circle a graph on a YouTube video and ask about it. Steps are drawn, then
   said, and the entry lands in your notebook.
3. **Coach mode:** in Excel, "teach me how to make a pivot table". Say "done" once without doing
   the step: it must notice and give a hint. Finish the walkthrough.
4. **Skills (S5):** open http://localhost:3000/review. The skill is under "Skills to re-check".
   Then say "let me try pivot tables on my own" and do it without help.
5. **Course-aware answers (S5):** import a course PDF, open one of its pages on screen and ask
   about it. The answer names the course and page.
6. **Quiz (S6):** on a lecture slide, "quiz me on this". Answer one question by voice, one typed
   and one picked. The next day they're in Review → Quick check.
7. **Notes Check:** on a lecture video, "check my notes". The panel lists differences and marks
   appear beside the text.
8. **Privacy:** "Neb, pause" stops capture; a password field or a blocked app is never sent;
   Screen Coach's windows don't appear in a Teams or OBS screen share.
