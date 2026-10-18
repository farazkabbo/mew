# Build Brief: Ambient AI Tutor That Lives Inside Your Notebook

> The original product brief this project is built from. Implementation status, decisions and
> deviations are tracked in [HANDOFF.md](HANDOFF.md).

You are the lead engineer on this project. Read this entire brief before writing any code. Then:

1. Propose a short implementation plan (milestones + file tree) and list any questions or assumptions.
2. Wait for my go-ahead, then build milestone by milestone.
3. After each milestone, run it, verify the acceptance criteria, and tell me what works and what doesn't before moving on.

Before using any third-party API (Gemini, ElevenLabs, Supabase), **check the current official docs** for exact model IDs, endpoints, and SDK usage. Don't rely on memory. Put every model ID in env vars so we can swap them.

---

## 1. Product in one paragraph

A tutor that lives inside a digital notebook and **stays quiet until it's actually needed**. The student writes by hand (stylus, mouse or trackpad) and talks out loud while studying. A small gating model called **Mew** listens to the live transcript plus notebook activity and decides whether the student needs a response. Only then does it call the main LLM (Gemini Flash). The tutor answers by **voice** (ElevenLabs TTS) and by **writing on the page in animated "ink"**: short text, symbols, diagrams, graphs, mind maps and flowcharts. It can also flag mistakes in the student's work and autocomplete handwritten steps. It works for **any subject** (math, physics, chemistry, biology, history, languages, programming) and builds a course from the student's own PDF, textbook or syllabus.

Design principles:

- **Silence is the default.** No interrupting, no five-paragraph answers to questions nobody asked.
- **Short, Socratic responses.** Hints and questions before full answers, unless the student asks for the answer.
- **The notebook is the primary surface**, not a chat window. Chat is secondary.
- **Honest progress.** Track whether each correct answer was independent, with a hint, or after an explanation.

UI reference: https://plue.si (calm, editorial, notebook-like). Don't copy their branding, assets or copy; match the _feel_.

---

## 2. Tech stack

**Monorepo (pnpm workspaces):**

```
/apps/web        Next.js (App Router) + TypeScript + Tailwind + shadcn/ui
/apps/desktop    Tauri v2 wrapper around apps/web (later milestone)
/services/api    FastAPI (Python 3.12): checkers, course ingestion, heavy LLM orchestration
/packages/shared Shared TS types (board actions, Mew labels, DB types) + JSON schemas
```

**Frontend**

- Next.js, TypeScript (strict), Tailwind, shadcn/ui (Radix), Framer Motion
- Canvas: custom HTML canvas on the **Pointer Events API**, ink smoothing with `perfect-freehand`
- Hand-drawn rendering for tutor diagrams: `roughjs`
- Graph layout for mind maps and flowcharts: `elkjs` (or `dagre`)
- Plots: `function-plot` or a custom sampler, rendered as ink strokes
- State: Zustand; local persistence: Dexie (IndexedDB) for offline notebook data
- Mew v2 (later): `@huggingface/transformers` (transformers.js) running a small classifier in-browser

**Voice**

- Speech-to-text: **ElevenLabs Scribe realtime** over WebSocket from the browser. The server mints a short-lived token so the API key never reaches the client (check the docs for the current token flow).
- Text-to-speech: **ElevenLabs** low-latency streaming TTS model.
- Do NOT use the ElevenLabs Agents product. We need our own gating logic.

**LLM**

- **Gemini Flash** (latest, via env `GEMINI_TUTOR_MODEL`) for tutor responses, using the official `@google/genai` / `google-genai` SDK. Use a low thinking budget by default; allow a higher one for "explain deeply" requests (configurable).
- **Gemini Flash-Lite** (env `GEMINI_GATE_MODEL`) for Mew v1, with thinking off.
- Gemini embeddings (env `GEMINI_EMBED_MODEL`) for retrieval.
- Always use **structured JSON output** (response schema) for anything the app parses.

**Backend & data**

- Supabase: Postgres, Auth, Storage (PDFs, page snapshots), **pgvector**
- FastAPI service: PDF parsing (PyMuPDF), SymPy checker, ingestion jobs
- Spaced repetition: `ts-fsrs`
- Code checker (programming subjects): Pyodide in the browser

**Env vars (create `.env.example`):**
`GEMINI_API_KEY, GEMINI_TUTOR_MODEL, GEMINI_GATE_MODEL, GEMINI_EMBED_MODEL, ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ID, ELEVENLABS_TTS_MODEL, ELEVENLABS_STT_MODEL, NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, API_BASE_URL`

---

## 3. Core loop (the heart of the product)

```
mic ──► Scribe realtime STT ──► transcript buffer ─┐
pen ──► stroke events (write / pause / erase) ─────┼──► Mew (gate)
                                                    │
                     label = ignore ────────────────┴──► do nothing
                     label = answer_question / check_work / give_hint / complete_step / draw_visual
                                     │
                                     ▼
      Context builder: transcript window + cropped image of the active page region
      + recognized text of recent lines + course context (pgvector) + learner state
                                     │
                                     ▼
                Gemini Flash ──► structured TutorResponse (JSON)
                                     │
                     ┌───────────────┴────────────────┐
                     ▼                                ▼
         speech text ──► ElevenLabs TTS      board actions ──► ink renderer (animated)
```

**Barge-in:** if the student starts speaking or writing while the tutor is talking, fade out TTS within ~200 ms and pause ink animation.

**Latency targets:** Mew decision < 400 ms (v1) / < 30 ms (v2). First audio within ~1.5 s of the end of a question.

---

## 4. Mew — the gating model

Mew decides _whether_ and _how_ the tutor should respond. It never generates the answer itself.

**Triggers to evaluate Mew:**

- End of an utterance (STT final segment / VAD silence ≥ 700 ms)
- Pen pause ≥ 1.5 s after writing a line (for check_work / complete_step)
- Explicit summon: tap the mascot button, or say the wake phrase "Hey Mew"

**Input:**

```ts
type MewInput = {
  lastUtterance: string;
  recentTranscript: string[]; // last ~6 segments
  notebookSignals: {
    msSinceLastStroke: number;
    justErased: boolean;
    linesWrittenLast60s: number;
    activeRegionText?: string; // recognized text of the current line, if any
  };
  tutorSpokeRecently: boolean;
  explicitSummon: boolean;
};
```

**Output:**

```ts
type MewLabel =
  "ignore" | "answer_question" | "check_work" | "give_hint" | "complete_step" | "draw_visual";
type MewOutput = { label: MewLabel; confidence: number; reason: string };
```

**Rules:**

- Default to `ignore`. Reading aloud, thinking out loud ("okay so…", "hmm"), self-talk and filler → `ignore`.
- A direct question ("why is this negative?", "what's the difference between mitosis and meiosis?") → `answer_question`.
- "Is this right?" or a long pause after a written step → `check_work`.
- "I'm stuck" / "I don't get it" → `give_hint`.
- "What's next?" mid-derivation → `complete_step`.
- "Can you show me / draw / graph / map this?" → `draw_visual`.
- Only act if `confidence ≥ MEW_THRESHOLD` (default 0.7, configurable in settings). `explicitSummon` bypasses the threshold.
- Cooldown: don't fire again within 4 s of the tutor finishing unless the student asks a new question.

**Mew v1:** Gemini Flash-Lite call with a strict system prompt and JSON schema.
**Mew v2 (later milestone):** log every Mew input/output (with the student's opt-in) to a `mew_events` table, add a small labeling UI, export a dataset, fine-tune a small text classifier (e.g. ModernBERT/DistilBERT) and run it in-browser with transformers.js. Keep v1 as a fallback when confidence is low.

Put Mew behind an interface (`MewGate.decide(input): Promise<MewOutput>`) so v1 and v2 are swappable.

---

## 5. The notebook canvas

**Data model (strokes as vectors, not pixels):**

```ts
type Point = [x: number, y: number, pressure: number, t: number];
type Stroke = {
  id: string;
  pageId: string;
  author: "student" | "tutor";
  points: Point[];
  color: string;
  width: number;
  bbox: [x: number, y: number, w: number, h: number];
  createdAt: number;
  groupId?: string; // tutor strokes grouped per response
};
```

**Features:**

- Pen, highlighter, eraser (stroke eraser), lasso select, undo/redo, pages, zoom/pan
- Dot-grid background (plue-style)
- Pressure support for Apple Pencil / Wacom via Pointer Events; palm rejection basics
- **Line segmentation:** cluster student strokes into lines by y-overlap and time, so we can crop "the current line" or "the current problem" as an image for Gemini
- **Recognition:** send cropped PNG regions to Gemini and get back recognized text + LaTeX (if any) + detected subject. Cache by stroke-group hash.
- Tutor strokes render in a distinct color (soft violet) and can be hidden/shown

---

## 6. Tutor ink rendering

The tutor never pastes rendered text boxes; everything appears as **animated ink** on the page.

**Board action schema (TutorResponse from Gemini):**

```ts
type TutorResponse = {
  speech: string; // what to say out loud, 1–3 short sentences
  actions: BoardAction[];
};
type Anchor = { near: "active_line" | "below_active_line" | "margin_right" | "free_space" };
type BoardAction =
  | { type: "write_text"; text: string; anchor: Anchor }
  | { type: "write_math"; latex: string; anchor: Anchor }
  | { type: "mark_error"; targetLineId: string; note: string } // circle/underline + short note
  | { type: "mark_correct"; targetLineId: string } // small check mark
  | { type: "complete_step"; latex?: string; text?: string; anchor: Anchor }
  | {
      type: "draw_plot";
      expressions: string[];
      xRange: [number, number];
      yRange?: [number, number];
      anchor: Anchor;
    }
  | {
      type: "draw_graph";
      kind: "mindmap" | "flowchart";
      nodes: { id: string; label: string }[];
      edges: { from: string; to: string; label?: string }[];
      anchor: Anchor;
    }
  | { type: "draw_shapes"; shapes: Shape[]; anchor: Anchor }; // arrows, boxes, circles, lines
```

**Rendering pipeline:**

1. **Placement engine:** resolve each anchor to free space on the page (avoid overlapping student strokes using a bbox occupancy grid).
2. **Glyph library:** single-stroke vector paths for a–z, A–Z, 0–9, common punctuation, and math/science symbols (+ − × ÷ = ≠ ≈ ≤ ≥ √ ∫ Σ π θ λ Δ → ⇌ °, etc.). Start with an open-source single-line font (Hershey fonts or similar), stored as JSON.
3. **Scale to the student:** measure the median x-height of the student's recent writing and scale glyphs to match. Add slight jitter (rotation, baseline wobble) so it looks handwritten.
4. **LaTeX → ink:** parse a practical subset (fractions, superscripts, subscripts, roots, Greek letters, operators) into positioned glyphs. If parsing fails, fall back to plain text.
5. **Diagrams:** mind maps/flowcharts use elkjs for layout, then roughjs for hand-drawn boxes and arrows, converted to strokes. Plots sample the function, draw axes and ticks as ink, and animate the curve.
6. **Animation:** draw strokes progressively (stroke-dash style) with realistic pacing, roughly synced to TTS playback.
7. Tutor strokes are real `Stroke` objects (`author: "tutor"`), so they're saved, undoable and erasable.

---

## 7. Checking work (any subject)

A **checker router** picks the right verifier based on the detected subject and content. Never trust the LLM for arithmetic or symbolic algebra.

| Content                                              | Checker                                                                                                                |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Algebra, calculus, physics equations                 | SymPy on FastAPI: check whether line N is equivalent to line N−1 or the target; check units with `sympy.physics.units` |
| Code                                                 | Pyodide in-browser: run the snippet and compare with expected output or tests                                          |
| Chemistry equations                                  | Atom/charge balance check (simple parser)                                                                              |
| Everything else (essays, history, biology, language) | Gemini with a rubric prompt grounded in course material via retrieval                                                  |

Flow: the checker finds a problem → Gemini explains _briefly_ why, as a hint first → `mark_error` action on the line.

---

## 8. Course ingestion (from PDF / syllabus / topic)

1. Upload a PDF to Supabase Storage, or paste notes or a topic.
2. FastAPI job: parse with PyMuPDF (text + page images); for scanned or diagram-heavy pages, send page images to Gemini.
3. Chunk by heading/section, embed, store in pgvector with page references.
4. Gemini extracts a **concept graph**: concepts, short descriptions, prerequisite edges, linked source pages.
5. **Scope review screen:** the student sees the proposed concepts in order and can remove, merge or reorder them before starting. Optional exam date.
6. Each concept gets a lesson: short explanation, worked example and practice questions, all generated on demand and cached.

---

## 9. Learner model

- Every attempt is logged with `evidence`: `"independent" | "with_hint" | "after_explanation"`.
- Concept mastery only increases meaningfully from `independent` evidence.
- FSRS (`ts-fsrs`) schedules review cards for each concept.
- Concept status shown in the UI: `Not started · Explored · Practised with hint · Checked · Revisit`.
- If there's an exam date, prioritize unchecked and "revisit" concepts in the remaining days.

---

## 10. Database schema (Supabase / Postgres)

Write migrations for:

- `profiles` (id, name, settings jsonb incl. mew_threshold, voice_id)
- `courses` (id, user_id, title, subject, exam_date, created_at)
- `sources` (id, course_id, storage_path, kind, page_count)
- `chunks` (id, source_id, page, text, embedding vector)
- `concepts` (id, course_id, title, summary, order_index)
- `concept_edges` (from_concept, to_concept) — prerequisites
- `concept_sources` (concept_id, chunk_id)
- `notebooks` (id, user_id, course_id nullable, title)
- `pages` (id, notebook_id, index, background)
- `strokes` (id, page_id, author, points jsonb or compressed bytea, bbox, color, width, group_id, created_at)
- `tutor_turns` (id, page_id, mew_label, transcript, response jsonb, latency_ms, created_at)
- `attempts` (id, user_id, concept_id, correct, evidence, created_at)
- `review_cards` (id, user_id, concept_id, fsrs_state jsonb, due_at)
- `mew_events` (id, user_id, input jsonb, output jsonb, human_label nullable)

Enable RLS so users only access their own rows.

---

## 11. Tutor system prompt (starting point; keep it in `/packages/shared/prompts/tutor.md`)

> You are a calm, concise tutor writing in a student's notebook. You only speak when needed. Keep `speech` to 1–3 short sentences. Prefer a guiding question or a hint over giving the answer, unless the student explicitly asks for the answer or has already tried twice. Ground explanations in the provided course material when available and mention the page if useful. When the student's work has an error, point to the specific line and give the smallest useful hint. Use board actions to show, not tell: write a key step, sketch a diagram, or draw a plot. Keep written text on the board very short (a few words or one equation). Match the student's level. Output only valid JSON matching the TutorResponse schema.

Also write prompts for: Mew v1, recognition, checker explanations, concept-graph extraction, lesson generation and practice questions. Each one uses a JSON schema.

---

## 12. UI / design

Feel: calm, editorial, notebook-like (reference: plue.si). Original branding only.

- **Layout:** dark left sidebar + light main notebook.
  - **Sidebar:** New course, Notebooks, Review, Library; Study modes (Quiz me, Mind map, Flowchart, Just practise); Courses list.
  - **Main:** dot-grid notebook page; a slim floating toolbar (pen, highlighter, eraser, lasso, colors, undo/redo); a mascot button bottom-right that shows Mew's state.
- **Mew states (mascot):** sleeping/listening (idle), thinking, speaking, muted. A small, unobtrusive pulse when listening.
- **Tutor speech:** optional caption bubble near the mascot (togglable), collapsible conversation drawer on the right for history and typed questions.
- **Typography:** a serif for headings (e.g. Instrument Serif or Fraunces), a clean sans for UI (e.g. Inter).
- **Color:** off-white page, near-black sidebar, soft violet for tutor ink, soft blue accent, red-orange for error marks, green for checks.
- **Motion:** Framer Motion; ink draws itself; nothing bounces aggressively.
- Fully keyboard accessible; supports light/dark; responsive down to tablet width.
- **Settings:** mic on/off, Mew sensitivity slider (threshold), voice choice, captions on/off, "answer style" (hints first vs direct).

---

## 13. Milestones

**M0 — Scaffold.** Monorepo, Next.js app, FastAPI service, Supabase project wired, `.env.example`, lint/format, a README with run instructions.
_Accept:_ `pnpm dev` runs web + api; health check passes.

**M1 — Notebook canvas.** Pen/eraser/undo, pressure, pages, zoom/pan, dot grid, local persistence, line segmentation, crop-region-to-PNG utility.
_Accept:_ smooth writing at 60 fps on a laptop; reload keeps strokes; I can export a crop of the current line.

**M2 — Voice in + Mew v1.** Scribe realtime transcript with a live caption (debug panel), Mew v1 with labels shown in the debug panel, mascot states.
_Accept:_ saying "okay so I'm reading this…" → `ignore`; "why does the force cancel out?" → `answer_question`.

**M3 — Tutor response + voice out.** Context builder (transcript + page crop + recognition), Gemini TutorResponse, ElevenLabs streaming TTS, barge-in.
_Accept:_ ask a question aloud and hear a short answer in under ~2 s; interrupting stops it.

**M4 — Ink output.** Glyph library, scaling to student handwriting, placement engine, write_text / write_math / mark_error / mark_correct / complete_step animations.
_Accept:_ the tutor writes a short equation next to my line, at my writing size, without overlapping my work.

**M5 — Checking work.** Pen-pause trigger, checker router, SymPy service, Pyodide code checker, rubric fallback.
_Accept:_ I write a wrong algebra step → it gets circled with a short hint; a correct step gets a small check.

**M6 — Visuals.** draw_plot, mind map, flowchart (elkjs + roughjs → ink).
_Accept:_ "draw a mind map of the causes of WW1" and "graph y = sin x" both appear as hand-drawn ink.

**M7 — Courses.** PDF upload, ingestion, concept graph, scope review screen, retrieval in tutor context, lesson view.
_Accept:_ upload a chapter PDF → see ordered concepts with prerequisites → tutor answers cite the right pages.

**M8 — Learner model + review.** Attempts with evidence, mastery states, FSRS review queue, exam-date planning, Quiz me mode.

**M9 — Desktop + polish.** Tauri wrapper for Mac, settings, onboarding, error states, telemetry for latency.

**M10 — Mew v2.** Logging, labeling UI, dataset export script, fine-tuning notebook, in-browser classifier with v1 fallback.

---

## 14. Engineering rules

- TypeScript strict; Python typed (Pydantic models for every API payload).
- All LLM outputs validated against schemas (zod on TS side, Pydantic on Python side); on validation failure, retry once, then degrade gracefully (speech only, no ink).
- No API keys in the client. All Gemini calls go through server routes or FastAPI.
- Centralize prompts in `/packages/shared/prompts`, versioned.
- Log latency for each stage (STT final → Mew → Gemini first token → TTS first audio → ink start).
- Write unit tests for: line segmentation, placement engine, LaTeX→glyph layout, SymPy equivalence checker, Mew label parsing.
- Keep components small; no file over ~400 lines without good reason.
- Ask me before adding paid services or major dependencies not listed here.

## 15. Non-goals for now

- Replicating each student's exact handwriting (glyph library + scaling is enough; handwriting synthesis is a future idea)
- Multiplayer/real-time collaboration
- Mobile phone layout
- Teacher/classroom dashboards
