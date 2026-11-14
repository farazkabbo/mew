# Redesign brief: the notebook home (Pages · Study · Moments)

This brief was given to Claude Design on 2026-11-04. The boards in this folder (`Pages`,
`Study`, `Moments`, `Components`) answer it. Each board has `night` and `state` props in its
`data-props` showing every state. Where a board and the code disagree on behaviour, the code
wins (docs/NEB_APP_UI.md decision U28).

## The screen

The notebook home is what opens when a student clicks a notebook. A notebook is the whole
class (decision U26): its chapters and pages, its course material, and what was saved from the
screen. It has at most three tabs:

- **Pages:** always.
- **Study:** once course material has been added.
- **Moments:** once something was saved from the screen.

The left sidebar (the notebook tree) stays as it is.

## Content to keep (behaviour doesn't change)

- **Header:**
  - The top bar has back, the breadcrumb and the marking level (Quiet / Hint / Coach).
  - The title block has the notebook's icon in its cover colour, its name, "1 chapter · 47
    pages" and Subject.
  - A notice card can sit above the tabs: checks due (with Quick check); "neb is finding the
    topics in your PDF…"; "neb found the topics…" (with Review topics).
- **Pages:**
  - Chapter cards, each with its number and title, checks due, course progress ("3 of 8
    topics checked") and "5 pages · edited 2 hours ago".
  - Add chapter.
  - Loose pages, each with a move button, draggable onto a chapter card.
  - New page and Import PDF.
  - On a notebook with no course, the "Have the syllabus or slides?" card, with Add course
    material and Use a course you have.
- **Study:**
  - A summary, Quiz me, the exam date and the exam plan.
  - The concepts in course order, each with its status, when it comes back, what it needs and
    its pages. Each opens its lesson.
  - Other states: building, review-the-plan (rename, move up or down, merge into the one
    above, remove, Start studying), failed, and empty.
- **Moments:**
  - Search, and filters (All, Videos, Web pages, PDFs, Apps).
  - Each moment has a thumbnail, its question, its source and day, Replay, Open source, and
    Check against my notes.
  - Unsorted adds File these.

## Rules

- Use the design tokens in `packages/shared/src/ui/tokens.ts`: colours, the four fonts,
  shadows, and pill buttons.
- Violet only where neb acts or speaks.
- No streaks, XP, badges or confetti.
- Copy is plain sentence case. Never use "wrong", "incorrect", "error", "fail" or "easy" in
  student-facing text.
- Calm and uncluttered: a feature shows only when it applies.

## Fixed by these boards

- **One breadcrumb.** The duplicate breadcrumb above the title is gone.
- **Tabs that look like dividers.** The plain text tabs are replaced.
- **A styled Subject select.**
- **A Study list that shows status.** It's no longer a flat list where the page numbers and
  prerequisites read as noise.
- **Moments grouped by source.** The thumbnails are larger, and the source line is no longer
  repeated on every row.
- **The stray "Check against my notes" pill is gone.** It now lives on each moment.
- **The old mascot blob is gone.**
