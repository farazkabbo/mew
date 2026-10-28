# Handwriting evals

The eval set for handwriting recognition (docs/NOTEBOOKS_K.md §8.1, K10). Run with
`pnpm eval:handwriting` (real model; skipped without `GEMINI_API_KEY`). The latest report is in
`reports/latest.md`.

| File / folder    | What it is                                                                                                                                                                                                         |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `corpus.json`    | 151 lines of student working in 9 categories (algebra, fractions, exponents, calculus, physics units, physics vectors, chemistry, code, prose), grouped by problem so each line has the lines above it as context. |
| `writers.ts`     | 10 synthetic writers (slant, size, a pen or a mouse, neat or messy, two with quirks: a 7 like a 1, a z like a 2). Every corpus line × every writer = 1,510 lines. Seeded.                                          |
| `samples/*.json` | Real handwriting from the team and opt-in beta users, captured with `/dev/handwriting`. Counted in every run.                                                                                                      |
| `reports/`       | `latest.md` (per category, neat and messy, confusion table, personalization) and `latest.json` (the same, plus every misread line).                                                                                |
| `LICENSES.md`    | Where every sample comes from and what it may be used for.                                                                                                                                                         |

## What the numbers mean

The synthetic writers draw the tutor's own single-stroke font with noise. They are cleaner than
most students and their mistakes are ours, so they measure the pipeline and catch regressions;
they don't say how well neb reads real students. The targets in §8.1 (maths equivalence ≥ 95 %
neat and ≥ 88 % messy, prose CER ≤ 4 %) are judged on real samples once there are enough
(§8.1 asks for 1,500, from different writers and devices). Until then the report says how many
real lines it counted.

## Modes

- **baseline:** recognition as it was before K10: the line as drawn on the page (each stroke's
  own width, no deskew), prompt `recognition.v2`, one reading.
- **k10:** the line drawn from its strokes (deskewed, letters at a fixed size, an even pen, on
  white), prompt `recognition.v3` with the context block (the 2 lines above, the problem, the
  subject, the chapter's name) and top-3 readings, the reading chosen by logic (`chooseReading`:
  SymPy, formulas, code that parses).
- **personalization:** writer w03 (their 7 looks like a 1) corrects 5 lines and writes a
  calibration 7; the held-out lines with a 7 are read with and without that profile.

## Adding real samples

1. Run the app in development and open `/dev/handwriting`.
2. Pick the writer id (initials are enough, never a name), the device and neat or messy; type
   what you'll write (its text, and LaTeX for maths and chemistry); write it; Add.
3. Download the JSON and put it in `samples/` with a name like `team-<initials>-<date>.json`.
4. Add a line to `LICENSES.md`.

Samples hold strokes only (no picture, no name, no page). Beta users' samples need their opt-in
(K11's consent) before they are collected.

## CI

`.github/workflows/evals.yml` runs this eval when the recognition prompt, the pipeline or the eval
changes, with the repository's `GEMINI_API_KEY` secret (it skips itself without one).
