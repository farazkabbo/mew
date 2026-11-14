# Plan: annotations, teaching cursor, token budget (from Plip, MIT)

**Stack:** Windows 10 2004+/11. Tauri 2 + Rust (capture, overlay, UI Automation, Windows OCR,
marks), Next.js server routes calling Gemini (Interactions API, zod-validated JSON), FastAPI +
Supabase (entries, moments), the TS ink planner (`@mew/ink`). Plip is macOS + Claude: its ideas
are rewritten in Rust/TS, not copied (see THIRD_PARTY_NOTICES.md). Branch:
`feat/neb-annotations-tokens`. Built 2026-11-08; the owner commits.

**Decision: JSON, not inline tags.** The answer stays a validated JSON object streamed field by
field (speech is spoken before the actions finish). Plip's `[POINT]`/`[MARK]` tags would bypass
the schema checks and the safety rules, which run on JSON. Coordinates stay 0–1000 on the focus
crop; speech is its own field, so a tag can never be spoken.

## Part 1: the learner's annotation (mostly built in S3.2)

- Already there: `marks.rs` (circle/underline/arrow/tap/loose, simplify, target words, region),
  `win/uia.rs` + `win/ocr.rs`, the focus crop cut from the full-resolution capture, then scaled.
- Added: what's outside a circle is dimmed to 35% in the model's copy (`raster::dim_outside`,
  grown 8% so touching words stay bright); a ±2 px crop test at 100–200% and on a monitor left
  of the primary. Windows OCR gives no confidence, so none is stored (text-first uses words).

## Part 2: neb's marks in the right spots

- Added: a labelled arrow snaps onto the words its label names when they're within 120 CSS px
  of the model's point (`ScreenText::spot_for_label`, Plip's snap scoring, threshold 0.55; done
  in Rust because the overlay only ever gets rectangles); fuzz tests for the streaming reader.

## Part 3: teaching features

- Added: "Done" on a screen that hasn't changed since the step was shown is answered on the
  device, without a model call or a hint (`glance.rs`, Plip's 64×40 fingerprint thresholds); a
  second "Done" still goes to the server. Save as PDF for a moment (its note), a page (the ⋯
  menu) or a chapter (the tree's menu): `export-pdf.ts`, `pdf-lib` 1.17.1, no model call; ink as
  vectors, words drawn by the browser so every script prints. Practice from a moment is S6's.
- **Teach from your notes** (owner, 2026-11-08): screen and circle questions bring the student's
  own matching lines (Notes Check's search, device token); the answer says where they wrote it
  and teaches from it (`fromNotes`). When they asked neb to do it ("solve this for me"), the app
  opens Neb at that page and marks the line ("You wrote this") instead of doing it.

## Part 4: tokens per question (`pnpm eval:tokens`, gemini-3.5-flash-lite)

| Turn                                      | Input before | Input after | Saved |
| ----------------------------------------- | -----------: | ----------: | ----: |
| Circle a maths line, "explain"            |        4,031 |       2,390 |   41% |
| Circle a paragraph, "what does this mean" |        4,052 |       2,474 |   39% |
| A general question (no screen needed)     |        2,023 |       1,020 |   50% |

- How: Gemini 3 bills an image by its resolution (1,120 tokens unless set). The marked area now
  goes at medium (560), the window at low (280), and not at all when the marks' words carry the
  question; general questions go without the screenshot (`routing.ts`, English only); JSON is
  compact; nearby text is cut to the 20 blocks nearest the marks; identical questions about an
  identical picture reuse the answer for 10 minutes (`answer-cache.ts`).
- Not done, measured instead: splitting the prompts. Gemini's implicit cache already serves
  1,273–1,305 of a repeated circle turn's tokens; a rewrite would risk answer quality for the
  first turn of a session only. History was already 3 turns, and outputs (~400 tokens) sit well
  under their caps (a lower cap risks cut-off JSON and a paid retry).
- Budget test: `token-budget.test.ts` fails if circling a maths line goes over 2,630 tokens (2,390 measured, with the notes rule, + 10%).
