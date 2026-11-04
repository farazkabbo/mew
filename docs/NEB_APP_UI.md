# U: neb app UI ("the desk"): design system, screens and interactions

This is the **U series** (milestones U1–U7): a new look for the whole app, built on what the
M, S, N and K series already ship. It is the owner's "neb app UI" brief, rewritten against the
code as it is on 2026-10-27. Where the brief asked for something the app doesn't have, or does
differently, section 0.2 and the **Decisions** at the end say what we do instead. Both are
binding.

---

## 0. How to work

- **Token use:**
  - Don't restate this brief, print plans or summarize diffs.
  - Write each file once, complete.
  - Ask only if you're truly blocked.
  - End each milestone with tests plus a report of 5 lines or fewer.
- **Working agreement:** as in [HANDOFF.md](HANDOFF.md) §1, plus the owner's standing rule for
  the lettered series: **commit each milestone on its own new branch** (`feat/ui-u1-tokens`,
  `feat/ui-u2-page`, …), announce the branch name, and **never push**.
- **Stack:** the app's own. Next.js 16 + React 19, **Tailwind 4** with CSS variables in
  `frontend/src/app/globals.css` (`@theme inline`), **zustand** stores, Dexie, the page engine and
  canvas in `features/notebook/` and `packages/ink`. The desktop overlays are plain TypeScript
  pages (`desktop/overlay-src/*.ts` + `desktop/shell/*.html`). Don't add a UI framework or a
  component library. Icons stay **lucide-react** (stroke 1.8) plus our own SVGs for the n✓ mark
  and the lasso.
- **Visual reference:** the owner's design canvas "neb app UI" (claude.ai artifact
  `JyVwjJPT7ffmg7S2ASdM4b`), 6 boards. Their source is kept in `design/u/`
  (`01-desk.dc.html` … `06-keys.dc.html`); the HTML is readable as a spec even without its
  runtime. Screenshots, if the owner adds them, go beside them as `01-desk.png` … `06-keys.png`.
  Where a board and this document disagree, **this document wins** (it knows what the app does).
- **This series changes the UI layer.** Behaviour, data and models stay as defined in S3.2
  (Circle & Ask), the island (HANDOFF "The island and fixes"), N1–N5 and K1–K9. Where this brief
  moves or changes something, it says "**(changes K§x)**" or "**(changes island)**". The only
  data changes are the `stayed` column and view (§6.4) and two settings (theme, text size).
- **Ship order:** U1–U7 (section 12). Each milestone leaves the app working, with every existing
  test still passing.

### 0.1 Words

- The product is **neb**, lowercase, everywhere a student reads it (the page title stays
  "Neb" only where a platform capitalises it: the window title, the tray and the PWA name).
- The code keeps its names (`mew`, `Mew`, `useMewSession`, `mew:*` events). Renaming them is not
  part of this series.

### 0.2 What the brief assumed vs what we have

| Brief                                                             | The app today                                                                                                                    | What U does                                                                                                                                                                                  |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Desk home with covers                                             | `/notebook` opens the tree sidebar + `NodeHome`                                                                                  | `/notebook` with nothing open **is the desk** (§5.1). `NodeHome` stays as a node's overview, restyled.                                                                                       |
| No sidebar; chapter tabs                                          | K1 tree sidebar (`TreeNav`, ARIA tree, drag, trash, Unsorted)                                                                    | Tabs on the page (§4.5). The tree becomes the **Contents drawer** (§4.10), never removed: it's the only place for depth 3, drag-into and the trash.                                          |
| 3 levels Quiet / Hint / Coach                                     | `MarkLevel`: `off`, `quiet`, `normal`, `coach`                                                                                   | Labels Quiet / Hint / Coach; **Hint = `normal`**. `off` is reached from the neb dot. No data rename (decision U3).                                                                           |
| Margin notes as cards in a lane                                   | Notes are tutor **strokes** (glyph ink + arrow) from `tutor/live.ts`                                                             | Circles, underlines, ticks and "?" stay strokes in the tutor layer. The **words** move to a DOM `NebNote` in the lane, from the `Annotation` record (**changes K§7.1, K§7.3**, decision U4). |
| Ruled paper                                                       | `PageBackground`: `dot_grid`, `blank`, `lined`, `grid`                                                                           | The page keeps its own background; only the colours change (`--rule`, `--margin-red` for `lined`).                                                                                           |
| Pencil case: pencil, highlighter, eraser, circle & ask, 3 colours | `Toolbar.tsx`: pen, highlighter, eraser, **lasso**, 4 ink colours, 3 highlighters, S/M/L                                         | The pencil case keeps the lasso and sizes (decision U6).                                                                                                                                     |
| Screen coach while Ctrl+Alt is **held**                           | The **island** (double tap Ctrl+Alt) with Pen, Eraser, Select, Mic; the hold summons neb only when Screen Coach is off or paused | The frame, capsule and lasso cursor follow the island's sessions, not a held key (**changes the brief's §5.4**, decision U9).                                                                |
| "Teach neb your handwriting" in onboarding                        | K10 is built (`features/handwriting/Calibration`)                                                                                | Onboarding step 3 uses it (decisions U12, U17).                                                                                                                                              |
| Stayed count on covers                                            | FSRS on `moment_checks`; no stayed record                                                                                        | New `moment_checks.stayed_at` + view `notebook_stayed` (§6.4, decision U10).                                                                                                                 |
| Mascot                                                            | `features/mew/Mascot.tsx` (cat face, eyes, breathing)                                                                            | Replaced by `NebDot` everywhere (§3.8).                                                                                                                                                      |
| Violet `#6B4EE6` for neb                                          | `--tutor #8a7bf0`, also in strokes, the Rust indicator, overlays and `node-style.tsx`                                            | One violet, `--neb`; old stored hex values render as `--neb` (decision U2).                                                                                                                  |

---

## 1. The idea in one paragraph

neb's app is **a desk, not a dashboard**: notebooks you can see, pages that feel like paper, and
a tutor that sits **in the margin**, never on top of your work.

**Visual grammar:**

- Pencil grey is you.
- **Violet is neb, and only neb.**
- neb's _words_ are set in a small pixel font, and its _math ink_ is violet handwriting.

**Rules for convenience:**

- one hand on keys (two keys max), the other on the pencil
- nothing pops up mid-stroke
- every saved thing lands in the right chapter by itself, with an Undo
- progress is measured by **what stayed**, never by streaks

## 2. Principles (use these to settle any design question)

1. **The page is sacred.** neb never covers or rewrites the student's ink. Marks go _at_ the
   exact spot, words go in the **margin lane** (§4.2).
2. **Violet = neb.** No other UI uses the violet family: not links, not focus rings, not
   selection, not notebook colours. Focus rings are ink (§3.10).
3. **Calm by default.** No sound and no modals during writing. Toasts sit away from the pen.
   Everything neb does can be undone or dismissed with one tap.
4. **One hand, two keys.** Every action has a ≤2-key shortcut _and_ a voice phrase (§8). The
   shortcut table is `packages/shared/src/shortcuts.ts`; the UI reads it, never hard-codes keys.
5. **Show where things went.** Any save, file or move says its destination and why ("matched
   'projectile motion'"). K8's filing already returns the reason; the UI must always show it.
6. **Earned, not streaked.** The only score is **stayed** (§6.4). No streak flames, XP,
   confetti or leaderboards. The existing "Done: 3 of 4 right" summary goes (§5.5).
7. **Real objects, light touch.** Paper, tabs, sticky notes, a tray and a ribbon as recognisable
   shapes, not textures. Flat colours with small shadows.

---

## 3. Design system

### 3.1 Colour tokens

One source: **`packages/shared/src/ui/tokens.ts`** (plain objects, light and night). From it:

- `globals.css` gets the CSS variables and the Tailwind `@theme inline` names;
- `desktop/shell/tokens.css` is **generated** from the same file (a `scripts/` step run by
  `pnpm build:tokens` and checked in CI: the generated file must match);
- the contrast test (§3.10) and the Rust indicator's constant read the same values.

| Token          | Light     | Night desk | Use                                            |
| -------------- | --------- | ---------- | ---------------------------------------------- |
| `--desk`       | `#ECE6D8` | `#1B1F23`  | app background                                 |
| `--paper`      | `#FBF8F0` | `#22272C`  | pages and cards                                |
| `--paper-hi`   | `#FFFEFB` | `#2A3036`  | index cards, raised paper                      |
| `--ink`        | `#1E1D1A` | `#ECE6D8`  | primary text, primary buttons                  |
| `--pencil`     | `#26292E` | `#E2DED4`  | the student's default ink                      |
| `--muted`      | `#5F5A50` | `#A9A294`  | secondary text (4.5:1 on desk and paper)       |
| `--line`       | `#D3CAB7` | `#3A4047`  | hairlines, borders                             |
| `--rule`       | `#D6E2E6` | `#2F3A40`  | ruled lines, dots and grid on paper            |
| `--margin-red` | `#E9B9B2` | `#6A3E3A`  | the margin line                                |
| `--neb`        | `#6B4EE6` | `#9C86FF`  | neb: marks, buttons neb offers, the dot        |
| `--neb-ink`    | `#3F2BA0` | `#C9BCFF`  | neb's text (contrast-safe)                     |
| `--neb-wash`   | `#F1EDFF` | `#2C2550`  | neb note backgrounds, the solution strip       |
| `--note`       | `#F1E5AE` | `#5A5230`  | sticky notes, tape                             |
| `--teal`       | `#7DA4AF` | `#7DA4AF`  | brand sky; used sparingly                      |
| `--ok-pen`     | `#3E6DB5` | `#7FA6E8`  | the student's blue pen                         |
| `--red-pen`    | `#C2453A` | `#E07B70`  | the student's red pen (never used by neb)      |
| `--danger`     | `#A8402F` | `#E8907F`  | destructive actions only (Delete, Empty trash) |

**Old names** (`--paper-raised`, `--ink-muted`, `--rule`, `--dot`, `--sidebar*`, `--tutor`,
`--accent`, `--error`, `--check`) are removed in U1. Every use is migrated, mapped like this:
`paper-raised → paper-hi`, `ink-muted → muted`, `dot → rule`, `tutor → neb` (or `neb-ink` for
text), `check → neb` (ticks are neb's), `error → danger` for destructive actions and **`muted` for
everything else** (neb never shows "error" red to a student, §3.9), `accent → ink` (links,
focus, selection, the listening halo) and `sidebar → paper` (the Contents drawer is paper, not
black). A lint rule (`eslint` `no-restricted-syntax` on the old class names) keeps them out.

**Ink colours** (`features/notebook/palette.ts`): graphite `--pencil`, blue `--ok-pen`, red
`--red-pen`, green kept as `#2F7D55` / `#72C99B`. Strokes keep storing the light hex; the dark
remap gains the new values. Stored old values keep rendering: `#1d1c1a → pencil`,
`#2f5fd0 → ok-pen`, `#c8432b → red-pen`.

**Notebook cover colours** (student-picked; never violet): teal `#7DA4AF`, clay `#C98B6B`, ink
`#3A3833`, sage `#8FA98B`, mustard `#D4B45A`, sky `#9DB8D9`, rose `#C99AA4`, slate `#6F7C86`.
`node-style.tsx`'s palette is replaced by these 8. A notebook whose stored colour is violet or not
in the list shows the nearest of the 8 (by hue); its stored value only changes when the student
picks again.

**Night desk:** follows the OS theme by default. New setting **Appearance: System / Light /
Night** (`settings.theme`, local to the device, applied as `data-theme` on `<html>` before first
paint by an inline script, so there's no flash). Paper turns dark grey and pencil turns light.
Exports (page PNG/PDF, line export) always render light.

### 3.2 Type

| Role                                                    | Font                      | Sizes                                      |
| ------------------------------------------------------- | ------------------------- | ------------------------------------------ |
| Display (titles, questions)                             | **Instrument Serif** 400  | 72 / 32 / 28 / 22                          |
| UI                                                      | **Inter** 400 / 500 / 600 | 16 / 15 / 14 / 13 / 12 (12 is the minimum) |
| **neb's voice**                                         | **Pixelify Sans** 500     | 15 / 14 / 13, in `--neb-ink`, lowercase    |
| Ink sample text (placeholders, mock ink, export labels) | **Caveat** 500 / 600      | follows the page scale                     |

- **Bundled once, offline:** the four families' subsetted woff2 (latin + math symbols) are kept in
  `packages/shared/fonts/` with their OFL licence texts. The web app loads them with
  `next/font/local` (replacing `next/font/google`), the overlays with `@font-face` in
  `desktop/shell/fonts.css`. Total under 180 KB. No font package dependency.
- `font-display: swap`. Tabular numbers for times and counts.
- **neb's math ink stays Hershey glyph strokes** (`packages/ink`), drawn in `--neb`. Caveat is for
  mock ink and labels only; it never replaces the tutor's stroke handwriting.

### 3.3 Spacing, radius, shadow, layers

- **Spacing scale:** 4 · 8 · 12 · 16 · 20 · 24 · 32 · 40 · 56 (Tailwind's default steps already
  cover these; don't add arbitrary values).
- **Radius:** pill buttons full · cards 10–14 · paper sheets 6 · notebook covers `4 10 10 4` ·
  index cards 4.
- **Shadows (only 3):** `--sh-1: 0 1px 0 var(--line)` · `--sh-2: 0 10px 24px -14px #1E1D1A66` ·
  `--sh-3: 0 24px 50px -30px #1E1D1A99`.
- **Z-layers** (named in `tokens.ts`, used as `z-[var(--z-…)]`): page 0 → student ink 10 → tutor
  marks 20 → margin notes 30 → floating tools 40 → toasts 50 → palette and pickers 60. The screen
  coach overlays are separate topmost windows.

### 3.4 Motion

| Name               | Value                                                                                                                      |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `--t-quick`        | 120 ms ease-out (hover, press)                                                                                             |
| `--t-move`         | 220 ms `cubic-bezier(.2,.8,.2,1)` (panels, tabs)                                                                           |
| `--t-ink`          | marks draw at about 600 px/s (the existing `TutorInk` speed is retuned to this), then the margin text fades in over 150 ms |
| neb dot "watching" | a slow 3.2 s breathe (scale 1 → 1.06)                                                                                      |
| Strip fold (§5.3)  | 3 accordion segments, 280 ms total                                                                                         |

- **Reduced motion:** no breathing, no draw-on (marks appear complete), folds become fades. The
  existing `motion-safe:` pattern is the way to do it.
- **Never animate under the pen.** If the pen touches down while something animates, finish it
  within 150 ms (K§7.2; `LiveAnnotator` already does this for marks, the lane must too).

### 3.5 Buttons

- **Height:** 44 px minimum, or 36 px in dense desktop toolbars with a 44 px hit area.
- **Variants** (`components/ui/Button.tsx`):
  - `ink`: filled `--ink`, text `--paper`. Primary actions the student starts.
  - `neb`: filled `--neb`, white text. Only for actions **neb offers** (Start checks, Check my
    work, Replay with voice, why?, Show me, One more).
  - `ghost`: 1 px `--ink` border, transparent.
  - `quiet`: 1 px `--line` border, `--muted` text.
  - `danger`: `quiet` with `--danger` text; only inside confirmations.
- **Labels** are verbs: "Resume", "File", "Check my work". Never "OK" or "Submit". Existing
  dialogs' "OK" / "Cancel" become the verb and "Keep it" / "Not now".

### 3.6 Keycap

`components/ui/Keycap.tsx`: an inline `<kbd>`, height 20/22/26/44 px, 1 px `--line` border with a
2–4 px bottom border, `--paper` fill, Inter 600. **Pressed** (the key is really held): bottom
border 1 px, `translateY(2px)`, `--neb-wash` fill, `--neb` border. Labels come from
`shortcuts.ts` (`formatKeys`) so a rebinding in Settings → Shortcuts shows everywhere.

### 3.7 Iconography

- lucide-react, `strokeWidth={1.8}`, 20/24 px.
- The **lasso / circle-and-ask** icon (dashed ellipse, our own SVG) is the only icon drawn in
  violet. The selection lasso tool uses lucide's `lasso` in ink, so the two never look alike.
- No emoji anywhere in the UI (the island's ♫ becomes an icon).

### 3.8 The neb dot

`components/ui/NebDot.tsx`: a 30 px violet circle with the white n✓ mark, optional pixel label.
It replaces `Mascot` everywhere (the dock, the tutor panel, onboarding, settings preview).

| State       | Look                                         | Label       | Driven by                                 |
| ----------- | -------------------------------------------- | ----------- | ----------------------------------------- |
| `off`       | hollow grey ring                             | "off"       | level `off`, offline, Screen Coach paused |
| `watching`  | violet, slow breathe, 5 px `--neb-wash` halo | "watching"  | live annotations on, idle                 |
| `thinking`  | 3 pixel dots cycling                         | "looking…"  | a line check or a question in flight      |
| `has-note`  | violet with an ink badge: unresolved notes   | "2 notes"   | `LiveAnnotator` open marks                |
| `speaking`  | the halo follows the voice level             | none        | TTS playing                               |
| `listening` | a ring of 6 short bars                       | "listening" | mic open (`useMewSession`)                |

- **Tap:** opens the **neb panel**: level switch, fold, voice on/off, "what can I say?", and the
  existing tutor controls that lived in `MewDock` (mute, stop, debug panel behind its flag).
- **Long-press / right-click:** "Turn neb off for this notebook" (level `off`, decision U3).

### 3.9 Writing for neb (microcopy)

- **Lowercase, pixel font, at most 8 words** for margin notes. Questions over statements:
  "units?", "only the way up?", "sign?". `markHint` already produces 1–4 words; keep it.
- **Never** say "wrong", "incorrect", "error", "fail" or "easy". Say "not yet", "check this",
  "almost". This applies to existing strings too: the U1 copy pass greps the student-facing
  strings (features/, components/, overlay-src/) and a test fails on those words in neb's voice.
- **Praise is specific:** "that one stayed.", "you fixed the sign." Never "great job!".
- Student-facing UI copy (Inter) is sentence case and plain.

### 3.10 Accessibility

- Text contrast 4.5:1 or better, checked by a unit test over every text/background pair in
  `tokens.ts`, both themes. Violet text uses `--neb-ink`, never `--neb`, on light.
- **Focus:** 2 px `--ink` ring, 2 px offset (night: `--paper`). Never violet. Replaces
  `:focus-visible { outline: … var(--accent) }`.
- Every icon-only button has an `aria-label`. Marks are announced politely ("neb noted line 4:
  only the way up?") through one `aria-live="polite"` region in the lane. Notes are reachable
  with **Tab** through the margin.
- **Colours are never the only signal:** ✓ / ○ / ? shapes are distinct, covers carry their name.
- **Text size** setting, 90–130 % (`settings.text_scale`, local): scales the UI root font size,
  never the canvas.

---

## 4. Page anatomy (the core screen)

`NotebookApp.tsx` (1,049 lines) is split as it's restyled: `PageScreen.tsx` (header, sheet,
lane, tabs, replay bar) composes the components; the session wiring stays where it is.

### 4.1 Layout (tablet landscape 1194×834 and desktop ≥ 1100 px)

```
┌ header 64px: ‹ ☰  Physics › Ch 3 · Projectiles › Page 4      [Quiet|Hint|Coach] [Fold the margin Alt C] ⋯ ┐
│ ┌pencil┐  ┌──────────────── paper sheet ─────────────────────┐┌tab 1┐                               │
│ │ case │  │ neb lane │  student writing area (the canvas)      ││tab 2┐                               │
│ │      │  │ (margin) │                                        ││TAB 3│ ← active, same paper          │
│ └──────┘  │  ● dot   │                                        ││tab 4┐                               │
│           │  ✓ ✓     │                                        ││+ Alt N                              │
│           │ [note]───┼──○ circled part                        │                                     │
│           │          │                     [ask pill]         │                                     │
│           └──────────┴────────────────────────────────────────┘                                     │
│           [◀◀ Replay this page] ━━━━━━|━━━━|━━━━━━━━━━━━●──  6:41 of writing · 3 neb marks           │
└──────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

- `‹` goes to the desk; `☰` opens the Contents drawer (§4.10).
- The canvas keeps its own pan and zoom. The sheet is the canvas's frame; the lane is a DOM
  column beside it that reads the engine's current transform to line notes up (§4.2).
- `PageNav` (previous / next page) moves into the header overflow and **Alt + ↑ / ↓**.

### 4.2 The neb lane **(changes K§7.1, K§7.3 placement of words)**

- **Width:** 18 % of the sheet, clamped to 150–200 px. Left of the margin line in both
  writing-hand modes.
- **What goes in the lane** (`NebLane.tsx`, layer 30):
  - **the neb dot** (top-left)
  - **ticks**: the tick stays a tutor stroke at the end of the line; the lane shows nothing
    extra for it
  - **margin notes** (`NebNote.tsx`): `--neb-wash` card, 1.5 px `--neb` border, 10 px radius,
    ≤ 160 px wide, pixel text ≤ 8 words from the `Annotation` record's hint, and two buttons:
    **why?** (neb) and **got it** (ghost). Aligned to the line's baseline in screen space.
  - a dashed **"?"** card for low-confidence reads (K§8.2): "i read: 3x + 1 = 19. right?"
- **What stays on the page:** the mark itself, a tutor stroke in the marks layer (circle,
  underline, arrow). A **connector** (`MarkConnector.tsx`, 2 px `--neb`, straight, 4 px round
  end, drawn in an SVG in layer 30) runs from the note to the mark's bounding box.
- **No more glyph words on the page:** `tutor/live.ts` stops emitting the note-text and arrow
  strokes for `margin_note` / note marks; it still returns the hint text, which `records.ts`
  saves on the `Annotation`. Old pages that have glyph-note strokes keep them (no migration);
  the lane doesn't duplicate a note whose `stroke_group_id` already has text strokes.
- **Stacking:** at most 6 unresolved notes (the annotator's existing cap). Notes never overlap.
  If two lines need notes within 56 px, the later stacks below with a longer connector. If the
  lane is full, a "+2 more" chip expands the lane over the page at 60 % opacity until dismissed.
- **Scrolling and zoom:** notes follow their lines as the canvas pans and zooms. A note whose line
  is off-screen collapses into an arrow chip at the lane's top or bottom ("↑ 1 note").
- **Resolved:** when a line is fixed, the circle fades over 300 ms (already built), the note
  collapses into a ✓, and the connector goes.
- **Tap a mark or note:** the note focuses with **why?** (voice plus a 1–2 sentence pixel reply
  under the note, via the existing `askAboutLine`), **not wrong** (the existing correction log)
  and **got it** (the existing hide). This replaces `MarkLayer.tsx`'s tap menu.
- **Notes Check findings** (`NotesMarks.tsx`, `FindingCard.tsx`) are restyled with the same
  tokens in U2; moving them into the lane is left for later (decision U13).
- **Exports** draw the lane: the line export and page export include notes beside their lines,
  in Pixelify, so an exported page still shows what neb said.

### 4.3 Level switch **(K§7.1 levels; decision U3)**

`LevelSwitch.tsx`, a 3-segment pill replacing the level part of `MarksMenu.tsx`.

| Label              | `MarkLevel` | Shows                                                                                                                                          |
| ------------------ | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| **Quiet**          | `quiet`     | ticks and "?" only. Error marks are still worked out and saved, but not drawn; their count shows on the neb dot badge.                         |
| **Hint** (default) | `normal`    | ticks, circles and margin notes                                                                                                                |
| **Coach**          | `coach`     | Hint, plus neb may speak after **45 s** stuck on a line (was ~20 s), and offers **Show, then you** after 2 misses (built in decisions 120–130) |

- Active segment paper-coloured with ink text; the others `--muted`.
- Saved per notebook (`useMarkPrefs`, unchanged). When the day's budget is spent the switch shows
  Quiet with the existing notice.

### 4.4 Fold the margin **(K§7.1 "Hide marks until I'm done")**

- **Alt + C** or the header button. This is the existing `hideUntilDone`, made visible: the lane's
  width animates to 12 px with a crease shadow, and the marks layer hides.
- The neb dot stays visible as a small tab on the fold, showing the count ("3").
- **Unfold** with Alt + C or by tapping the fold. While folded, Alt + C means **check, then
  unfold** (the existing reveal path).

### 4.5 Chapter tabs (right edge of the sheet)

`ChapterTabs.tsx`, from the open notebook's children in `NotebookTree`.

- Vertical dividers stick 128 px out of the sheet. The active tab is 150 px, paper-coloured, and
  joins the sheet. The others use the cover's colour at 30–60 % tint.
- **Label:** "3 · Projectiles" (position · name). Truncate after 14 characters with a tooltip.
- **Tap:** that chapter's last-open page (kept per node in the tree store; its first page if
  never opened). **Long-press / right-click:** the existing row menu (rename F2, new section,
  move, delete with confirmation and Undo).
- **Drop a page** (a replay-bar thumbnail, a Ctrl + K result, or a Contents row) onto a tab to
  move it there (`repo.tree` move, Undo toast).
- The last tab is **"+ chapter Alt N"**, using the naming flow (§5.7).
- More than 7 chapters: the tabs scroll, with fade masks.
- **Sections** (depth 3) show as a small fan beside the hovered or long-pressed tab.
- A page at the notebook's top level (no chapter) or in Unsorted shows no active tab.

### 4.6 Pencil case (floating toolbar; decision U6)

`PencilCase.tsx` replaces `Toolbar.tsx` (its logic: tool, colour, size, undo/redo, is kept).

- **Shape:** a vertical ink pill, 60 px wide, radius full, `--sh-3`.
- **Order:** pencil, highlighter, eraser, **lasso (select)**, **circle & ask** (the only violet
  button), divider, 3 colour dots (graphite, blue, red), divider, undo, redo, hand toggle.
- **Long-press** the pencil for S / M / L; the highlighter for its 3 colours; a colour dot for
  green. The "Hide marks" eye moves to the header overflow ("Marks layer on/off").
- **Placement:** opposite the writing hand (new setting `writing_hand`, `right` default, plus
  the "R hand" / "L hand" toggle on the case). It moves vertically to stay ≥ 120 px from the last
  stroke and never overlaps the pen.
- **Collapse:** after 8 s of continuous writing it shrinks to a 12 px tab; hover or a tap near the
  edge brings it back.
- **Circle & ask** starts the same mode as holding Ctrl + Alt on the page (`HoldCircle`). The
  stylus barrel button does too (pointer `button === 2` with `pointerType === "pen"`), and palm
  rejection is unchanged.

### 4.7 Ask pill

`AskPill.tsx` replaces `MewDock`'s bar. Bottom-right of the sheet (bottom-left for left-handed).

- **Resting:** "Hold **Ctrl** **Alt** and circle anything, or just ask", plus a violet mic button.
- **Active:** expands to 640 px: a waveform while listening, the live transcript (Inter 16), and
  on the right a **destination chip** "→ Physics › Ch 3 **Ctrl D**" when the utterance has a save
  phrase (K3's `destinationPhrase`) or a save is pending.
- Typing works too (the existing text input). **Esc** closes it.

### 4.8 Replay bar **(K§7.3 Replay, K§4.7)**

`ReplayBar.tsx`, on `notebook/page-replay.ts`.

- **"◀◀ Replay this page"** (ink button), a scrubber, and "6:41 of writing · 3 neb marks"
  (writing time = summed stroke durations with gaps over 30 s cut).
- **Track:** written portion `#9A927F` (`--muted` at 60 % on night); **violet ticks** at each
  neb mark; **ink diamonds** at each saved Moment or screen entry on this page.
- **Dragging** redraws the page to that moment (ink and marks in order, the lane shows the notes
  as they were). Speeds 1× / 2× / 4×. **Space** plays and pauses while the bar has focus.
- Screen-entry pages keep their per-step Replay (`entry-replay.ts`) in `EntryNotes`.

### 4.9 Filing toast **(K§4.6)**

`FilingToast.tsx`, one toast host for the notebook (moves, File these, saves by voice, entries
that arrive filed).

- **Position:** bottom-centre of the sheet above the replay bar, **never over the current writing
  line**: if the pen's last point is in the bottom third, it goes top-centre.
- **Look:** an ink pill with a violet ✓: "Filed in **Physics › Ch 3** · matched “projectile
  motion”" plus **Undo · Change · Open**. A move made by the student says "Moved to …" with no
  reason.
- **Timing:** 6 s, paused while hovered or focused. Queued while the pen is down (§6.2).

### 4.10 Contents drawer (the K1 tree)

- `☰` in the header, or **Ctrl + \\**, slides the existing `TreeNav` in from the left as a paper
  drawer (320 px, `--sh-3`), over the pencil case. Everything K1 built works there: arrows, F2,
  Alt + ↑ / ↓ reorder, drag above / below / into, the row menu, Unsorted with its count, and the
  Trash.
- It closes on Esc, on choosing a page, or on pen-down on the sheet.

---

## 5. Screens

### 5.1 Desk (home)

`/notebook` with no node open renders `Desk.tsx`. Opening a node or page is a URL change
(`?node=…&page=…`) so Back returns to the desk.

- **Header (76 px):** the n✓ mark and wordmark; a greeting in Instrument Serif 30 ("Good evening,
  Faraz.", time-aware: morning / afternoon / evening / "Late one, Faraz." after 11 pm; the name
  is Clerk's first name, or no name when signed out); the **jump search** pill "Jump to any page
  or moment **Ctrl K**"; **New notebook Alt B** (ink button); the avatar, whose menu holds
  Courses, Review, Teach neb, Settings and Sign out (these pages keep their layouts and get the
  tokens; decision U14).
- **Left column (310 px):**
  1. **Tonight card** (`TonightCard.tsx`): an index card (white, red rule at the top, blue
     rules), **at most 3 rows**, chosen in this order:
     - due checks: moment checks due (`useMomentChecks`), "2 quick checks · about 4 min"
       (2 min each) → **Start** (neb button)
     - due skill re-checks (S5), desktop only: "re-check: pivot tables" → **Try it** (opens the
       desktop app's re-check through the bridge)
     - an unfinished page: the last-edited page if it has an unresolved mark or an open Your Turn
       ("Physics › Ch 3, page 4 · you stopped mid-problem"), otherwise the last-edited page today
       ("· you were here") → **Resume**
     - unsorted pages: "3 loose pages · neb found a chapter for each" (from
       `/v1/clips/suggestions`) → **File**
     - a PDF still importing (K4 import state) → **See it**
     - an exam within 7 days (`examSoon`): "Physics exam in 3 days" → **Plan**
     - nothing: "All clear. Open a notebook and write."
     - under the rows, in `--muted`: "stayed this week: 12" (§6.4)
  2. **Unsorted tray** (`UnsortedTray.tsx`): a shallow inset tray with up to 3 fanned page
     thumbnails (the page's ink rendered small; screen entries show their picture) and a violet
     chip on the top one ("→ Physics › Ch 2"). Tapping opens **File these** (the existing
     `FileThese`, restyled): one row per page with **Accept** or **Change**, plus **Accept all**.
     Empty Unsorted: the tray shows "nothing loose".
- **Main column:**
  - **Your notebooks** (`NotebookCover.tsx`): the root notebooks, 150×200 covers, wrapping
    (desktop: 5 per row).
    - The colour fill with a 12 px binding shadow on the left; an ivory label plate with the name
      (Instrument Serif 24, `node-style` icon beside it) and "5 chapters · 38 pages"; up to 3
      chapter tabs peeking from the right edge (the 3 most recently edited chapters' tints); the
      **stayed ribbon** from the top-right with its count (hidden at 0); a **sticky note** at the
      bottom-left when checks are due ("2 checks", Caveat 17, rotated −6°).
    - Under the cover: "Ch 3 · Projectiles · 1 h ago" (the existing `ago()`).
    - Tap opens the last page; long-press or right-click: Rename, Colour, Subject, Archive,
      Delete (the K1 row menu; "Archive" is moving to the trash's sibling state if it exists,
      otherwise left out, decision U15); drag reorders (`position`); a PDF dropped on a cover
      imports into it (K4).
    - The last tile is **"+ New notebook"** (dashed) with "name it first, always" (§5.7).
  - **Recent moments** (`MomentCard.tsx`): a 3-column grid of the 6 latest moments
    (`moments.ts` list). Card: a 92 px thumbnail of the clip with neb's circle (the stored
    marks), a source chip ("video · 4:12", "PDF · p. 41", "your page"), the question (Inter 600
    14), "Physics › Ch 3 · today" and **▶ Replay** (`replayEntry`). "See all" opens the Moments
    tab of that notebook's `NodeHome`.
- **Empty desk (first run):** a single dashed cover in the middle: "Your first notebook. What are
  you studying?", name field focused (§5.7).

### 5.2 Page

Section 4. **Header overflow:** Previous / next page, Export page, Page history, Marks layer
on/off, Make available offline (K4), Recognize text (PDF pages), Print, Move to… (Ctrl + D).

### 5.3 Show, then you **(changes K§6.1 steps 3–5: where the steps are shown)**

Restyles `features/solution/` (`SolutionLayer.tsx`); `flow.ts` is unchanged.

- **Trigger:** unchanged (Mew's `show_full_solution`, the Show me button in Coach, the offer after
  2 misses).
- **The student's request** appears as a white bubble at the top-right of the sheet with a small
  "you" pill.
- **The solution strip** (`SolutionStrip.tsx`): docked to the lane side, slides out 520 px over
  the page, starting **below** the problem line. `--neb-wash`, a 6 px `--neb` left edge, faint
  creases every 25 %, `--sh-2`. Header "neb · every step, drawn first" (pixel) and **▶ replay
  with voice**. Each step: a numbered pixel badge, the step in neb's stroke handwriting (the
  existing ink plan, drawn into the step row), the _why_ in pixel 13, and a K5 figure when the
  step has one (about 120×88). The **final step is a check by a second method** whenever the
  verifier produced one (`uncertain` solutions show "neb isn't sure of this one" instead). Steps
  appear one by one with the voice (draw first, then say it).
- **The Your-turn card** (`YourTurnCard.tsx`): to the right of the strip, white paper rotated
  1.5°, yellow tape, ruled lines. "your turn · same idea, new numbers" (pixel), then the problem in
  Instrument Serif 30, a writing area ("start writing here…"; a code Your Turn shows the code
  editor), and **Check my work Alt C** (neb), **Peek at a step** (quiet), "a peek counts as a
  hint".
- **Fold rule:** the first pen-down in the Your-turn card folds the strip into a 40 px tab,
  "Solution · tap to peek" (the existing fold and peek; peek records a hint as now).
- **Finish:** a ✓ on the last line shows "you got it on your own." with **One more** (neb) and
  **Back to your work** (ghost). "Skip for now" lives in the card's overflow menu.
- Screen solutions (K7) adopted into a page use the same strip, folded.

### 5.4 Screen coach (desktop overlays) **(changes island; decision U9)**

The flows stay as built: the island (double tap Ctrl + Alt) with Pen, Eraser, Select, Mic,
Clear, Close and music; the hold that summons neb when Screen Coach is off or paused; the
circle card; coach mode's pill; Notes Check's panel; the quiz card. U7 restyles them with the
shared tokens and adds the frame.

- **The frame (`CoachFrame`):** a 4 px `--neb` frame around the display, plus an inner 40 px
  violet glow at 33 %, shown **whenever neb can capture**: while a Select / circle session is
  open, from the mic opening on a screen question until its capture is taken, and for the whole of
  a walkthrough (coach mode sees the monitor). It is the existing `win/indicator.rs` windows held
  open instead of flashed; the per-capture flash stays on top (S0's rule: visible on every
  capture). It fades within 150 ms when the session ends. **No capture happens while the frame is
  off, ever** (a Rust test asserts every capture call site requires the frame's token).
- **Status capsule** (top-right, its own small overlay): "neb sees your screen only while this
  frame is on", with the dot.
- **Island:** keeps its black notch shape and size (the owner's design). Inside: tokens, Inter,
  icons instead of ♫ and text glyphs; the status button becomes the `NebDot` states; Select's
  active state uses `--neb`; nothing else on it is violet.
- **Keys indicator:** only for the hold (Screen Coach off or paused): bottom-left pressed keycaps
  **Ctrl + Alt** with "held · circle anything, then talk or type".
- **Lasso cursor:** while Select is on, the draw overlay's cursor is a violet dashed lasso; the
  closed loop is kept as a 3 px dashed violet ellipse (rectangle and ellipse selections already
  draw dotted).
- **The answer, `SketchCard`:** the circle card restyled: 330 px wide (grows to fit steps),
  paper colour, 4 px violet top edge, `--sh-3`, beside the circle (S3 placement). A 3 px violet
  **pointer line** from the card into the circle. "neb · sketch" (pixel 12), the figure, the pixel
  explanation, then the existing captions and Pause · Repeat · Next · Stop. Drag by its top edge.
  Esc, or a click outside the card and the circle, closes it.
- **Ask bar:** the card's ask box takes the `AskPill` look (waveform, transcript, destination chip
  "→ Physics › Ch 3 Ctrl D", the card mic).
- **`SavedStamp`:** the save toast becomes a postage stamp (paper fill, 2 px dashed `--line`
  border inside a 6 px paper outline) with a violet ✓ disc: "Saved to **Physics › Ch 3** ·
  matched 'vectors' · quiz in 1 day", **Undo** and **Open**, 8 s. Unsorted saves keep their chips
  and "+ New notebook".
- **Coach pill, Notes Check panel, quiz card, clip preview:** tokens, fonts and buttons only.

### 5.5 Moments and checks **(K§4.7)**

`CheckScreen.tsx` replaces `QuickCheck.tsx`'s layout (its logic, "Say it", `WritePad`, typed
answers, grading and FSRS stay). Opened from **Start** on the Tonight card, a cover's sticky note,
"quiz me on what I saved today", the Moments tab's **Check me**, and the Review page's Quick check.

- **Layout:** two columns, the moment (520 px) beside the check card. Under 900 px: stacked,
  check first.
- **Left, "The moment this check came from":** a 270 px thumbnail of the clip with neb's circle
  and a mini sketch card in the corner; **▶ Replay with voice** (stored TTS); the question in
  Instrument Serif 28 with quotes; "Oct 24 · lecture video at 4:12 · filed in Physics › Ch 3";
  **Open the video at 4:12** / **Open in neb** for PDFs (ghost) and **Move to…** (quiet). Merged
  cards list their moments as tabs. S6 quiz cards with no clip show "From your screen: <title>".
  - The left column starts **blurred**, "Try it first. Tap to see the moment.", and clears after
    an answer or a tap.
- **Right, the check card** (`CheckCard.tsx`): index card, "Quick check · 1 of 2" with progress
  bars. The question in Instrument Serif 32, then the answer area: **handwriting** by default
  (`WritePad`), **Type instead**, **Say it**, and multiple choice only for MC cards.
  - **Right:** a ✓ (pixel 30, violet) and "that one stayed. 3 days ago you circled it in a
    video." when it's a stayed event, otherwise "that one's right." (the second line names the
    source).
  - **Not yet:** a circle on the slip, a one-line hint, **Try again** or **Show me** (§5.3).
  - **"When it comes back"** (`SpacingTimeline.tsx`): 5 dots from the card's own FSRS history and
    next due date (saved → each past review → next → the one after, labels like "1 day ✓",
    "3 days · now", "1 week"). Past filled violet, current bold, future hollow.
  - **Buttons:** **Next check** (neb); **I don't know yet** (quiet), "that's fine. it comes back
    sooner." (graded `again`); at the right, "Physics stayed **34 → 35**" on a stayed event.
- **End of session:** the card flips to "2 of 2 done · 1 stayed today" and **Back to the desk**.
  The old "Done: x of y right" line is removed.

### 5.6 Two keys, max (keytips and the shortcuts sheet) **(K§11)**

- **Hold Alt for 400 ms** in the app: every control registered with `useKeytip(actionId)` shows
  its keycap badge at its top-right; releasing Alt hides them. Alt tapped alone does nothing else
  (the keyup is swallowed so the browser menu bar never opens). Never while the pen is down.
- **Shortcuts sheet** (`ShortcutsSheet.tsx`): "?" in the neb panel, Shift + ? anywhere outside a
  text field, or "what can I say?". A 4×2 grid of cards: keycaps, what it does (Instrument Serif
  26), the voice phrase (pixel violet). Keys come from the student's bindings.

| Keys                                                     | What it does                        | Or say                          |
| -------------------------------------------------------- | ----------------------------------- | ------------------------------- |
| **Ctrl + Alt** (hold in neb · double tap on your screen) | Circle and ask                      | "what's this?"                  |
| **Alt + C**                                              | Check my work, or unfold the margin | "check this"                    |
| **Ctrl + K**                                             | Jump to any page or moment          | "open physics chapter 3"        |
| **Ctrl + D**                                             | Choose where it's saved             | "save it to physics chapter 5"  |
| **Alt + B**                                              | New notebook, named first           | "new notebook called chemistry" |
| **Alt + N**                                              | New chapter here                    | "add a chapter called optics"   |
| **Alt + P**                                              | New page here                       | "new page"                      |
| **Ctrl + O**                                             | Bring in a PDF                      | (or drop it on a notebook)      |

Ctrl + N is a New-notebook alias in the desktop app only. Undo and redo stay Ctrl + Z / Ctrl + Y.
The first row says "double tap on your screen" only in the desktop app; on the web it says "hold".

### 5.7 Naming flow (new notebook or chapter) **(K§2.2)**

Replaces `CreateNotebookDialog`'s popover look; its logic (styles from the name, course,
"divided into", chapters by list or number) stays, shown under the cover as "More options".

- **A cover appears on the desk** with the label plate in edit mode: the cursor in the name field,
  placeholder "What's this notebook for?".
- **Below the cover**, the 8 colour swatches and a "subject" chip suggested from the name as it's
  typed (`notebook-tree.ts` suggestions; "Physics" → physics and teal). The chip is editable.
- **Enter** creates it. **Esc** with an empty name cancels; nothing is ever created untitled.
- **Chapters:** the new tab slides out with its name field focused, same rules.
- From a page or the Contents drawer, Alt + B goes to the desk and starts this flow.

### 5.8 Jump palette (Ctrl + K) and destination picker (Ctrl + D)

Restyles `JumpPalette.tsx` and `DestinationPicker.tsx` (search, `fuzzy.ts` and the K3 resolver
unchanged).

- **Jump palette:** a centred 640 px sheet (`--paper-hi`, `--sh-3`), input in Instrument Serif 22,
  results grouped Notebooks · Chapters · Pages · Moments (moments with thumbnails), matched
  characters underlined (never violet), arrows and Enter. Typing "> " lists the §5.6 commands.
- **Destination picker:** the same sheet with the tree, **recent destinations** as chips on top,
  "+ New chapter here" on hover, and **why** for the suggestion: "suggested: matched 'vectors'".

### 5.9 PDF pages

- A PDF page renders as a sheet with **no background pattern** and a 2 px paper border, so it's
  visibly printed. The lane is still on the left, outside the PDF box (the sheet widens).
- Circle & ask uses the text layer (K4's `circledPrinted`). Moments from a PDF show "PDF · p. 41".

### 5.10 Onboarding (first run, about 90 s, skippable at every step)

`Onboarding.tsx` is rebuilt as steps on the desk, not a modal:

1. **"Name your first notebook."** (§5.7)
2. **"Which hand do you write with?"** Two large buttons; sets `writing_hand`.
3. **"Teach neb your handwriting (60 s)."** K10's `Calibration`, with "skip, neb will learn as you go".
4. **"How much should neb mark?"** Quiet / Hint / Coach, each a mini page preview. Default Hint.
5. **Desktop app only, Screen Coach on: "Try it."** A sample slide in the main window: "double
   tap Ctrl Alt, pick Select, and circle the arrow." The first circle gets a real answer. Screen
   Coach off: this step offers to turn it on (its consent page) or skip.

### 5.11 Phone (≤ 600 px)

- The desk is one column: Tonight, then covers in a horizontal scroll, then moments.
- Pages are view and replay only, plus the check flow: "open on your tablet to write". (Writing
  stays possible on a phone when the student taps "Write anyway": the canvas works there today
  and this series doesn't take it away.)
- Checks fully work on the phone: handwriting with a finger, Type instead, or Say it.

---

## 6. States and rules

### 6.1 Empty, loading and offline

- **Loading:** paper-coloured shapes in the final layout, no spinners. Covers pulse lightly
  (opacity 1 → .7), not under reduced motion.
- **Offline** (`navigator.onLine` plus the sync layer's failures): a slim desk-coloured bar under
  the header, "offline · your writing is saved on this device". The neb dot is `off` with "back
  when you're online". Writing, Replay, the tree and cached PDF pages keep working; no ticks are
  made offline (the checkers are server-side).
- **Errors:** a plain sentence plus the fix ("couldn't reach neb. your page is saved. try
  again"). Never raw codes. Existing error strings are reviewed in the U1 copy pass.

### 6.2 Interruptions (never break flow)

- **Nothing modal while the pen is down,** or within 1.2 s of the last stroke. One shared
  `usePenCalm()` (from the page engine's pointer state) gates toasts, offers, keytips and the
  Coach voice.
- Toasts, notes and offers queue until the next pause (K§7.2).
- **Voice is off by default.** Coach can speak after a soft 2-note chime at −24 LUFS (a bundled
  short sample).

### 6.3 Undo

- The student's Ctrl + Z never undoes tutor marks (already true: `PageEngine.applyMarks`). Marks
  are dismissed with **got it**.
- Every filing, move and delete toast has **Undo**. Deletes go to the Trash for 30 days (K1).

### 6.4 "Stayed" (the only progress metric; decision U10)

- **Definition:** a stayed event happens when a moment check is answered correctly **at least
  24 h after** its moment was saved (the clip's `created_at`; for S6 quiz cards, the card's
  `created_at`). Each check card counts **at most once**.
- **Data:** migration `stayed`: `moment_checks.stayed_at timestamptz null`, set by the grading path
  (`server/moment-checks.ts` → FastAPI) with `where stayed_at is null` so a card counts once even
  under retries; view **`notebook_stayed`** `(notebook_id, stayed_count, stayed_week)` grouped by
  the card's root notebook, `security_invoker = on` so RLS applies; `stayed_week` counts the last
  7 days.
- **Display:** the cover ribbon (per root notebook), "N stayed today" at the end of a check
  session, and "stayed this week: N" on the Tonight card.
- Skills (S5) and course reviews (M8) aren't in a notebook and don't add to covers; they're not
  counted anywhere in U.
- No other counter is shown to the student. The Review page's mastery charts are untouched (they
  belong to courses), but its "right/asked" score line goes.

---

## 7. Components

New, in `frontend/src/components/ui/` (generic) and the feature folders (specific):

`Keycap`, `Button` (`ink` / `neb` / `ghost` / `quiet` / `danger`), `NebDot`, `NebNote`,
`MarkConnector`, `NebLane`, `LevelSwitch`, `MarginFold`, `PencilCase`, `ChapterTabs`,
`ContentsDrawer`, `AskPill` (with `DestinationChip`), `ReplayBar`, `FilingToast`, `SolutionStrip`,
`YourTurnCard`, `NotebookCover` (with `StayedRibbon` and `DueSticky`), `TonightCard`,
`UnsortedTray`, `MomentCard`, `CheckCard`, `SpacingTimeline`, `JumpPalette` / `DestinationPicker`
(restyled), `KeytipsOverlay`, `ShortcutsSheet`, `OfflineBar`. Desktop overlay equivalents in
`overlay-src/`: `CoachFrame` (Rust), status capsule, `SketchCard` and `SavedStamp` (in
`circle-card.ts`), the island restyle.

**Each component gets:**

- a preview on **`/dev/ui`** (`app/(app)/dev/ui/page.tsx`), rendering every state listed here,
  served only when `NODE_ENV !== "production"` or `NEXT_PUBLIC_DEV_UI=1` (a `notFound()` otherwise,
  plus a test for that);
- a light and night Playwright screenshot (`toHaveScreenshot`) of its `/dev/ui` section;
- keyboard and focus tests for the interactive ones (vitest + Testing-Library style already used,
  or Playwright where focus order across components matters).

## 8. Voice phrases the UI must surface

- **Every button with a voice equivalent shows the phrase in its tooltip**, e.g. _Check my work
  (Alt C) · or say "check this"_. The phrases live beside the actions in `shortcuts.ts`.
- **The neb panel's "what can I say?"** lists the §5.6 phrases plus "why?", "show me", "just tell
  me the answer", "quiz me on what I saved today", "fold the margin", "hide neb on this page",
  "move this to chemistry chapter 2", and on desktop "neb, pause" and "let me try … on my own".
- "fold the margin" and "hide neb on this page" are new Mew notebook commands (prompt bump
  `mew-gate.v3`, eval cases added); the rest exist.
- **Voice never deletes** (K§2.3).

## 9. Platform notes

- **Tablet** (the PWA; primary writing surface): landscape as above; portrait: the pencil case
  is a horizontal pill at the bottom, chapter tabs become a top strip, the lane is 22 % wide.
- **Desktop (Tauri, Windows):** the same web app plus the overlays (§5.4). The tray shows the neb
  dot states and **Pause neb for 1 hour** (the existing pause, with a 1 h preset).
- **Web:** as desktop without the overlays. Ctrl + Alt hold works on neb's own pages only.

## 10. Performance budgets

- Page open to first ink paint: **≤ 300 ms** for a cached page (a Playwright timing check on a
  200-stroke fixture page).
- **Writing latency unchanged.** The lane and connectors are DOM/SVG in their own layer; they
  never trigger a re-layout or redraw of the ink canvas. Lane positions update on the engine's
  transform change, throttled to animation frames.
- Desk with 30 notebooks: under 16 ms a frame while scrolling. Thumbnails 2× WebP, lazy-loaded
  (`loading="lazy"`), cached in Dexie.
- Fonts: 4 families, subsetted, under 180 KB total (a test checks the folder's size).

## 11. Non-goals

- No streaks, XP, badges, confetti, leaderboards or mascots that move on their own.
- No chat sidebar. neb lives in the margin, the ask pill and the sketch card only.
- No violet anywhere that isn't neb.
- No auto-creating notebooks or chapters without a tap (K§4.6).
- No full-screen modals during writing.
- No renaming of code identifiers (`mew` → `neb`).
- No change to how marks are decided, filed, graded or scheduled.

## 12. Milestones

| #      | Scope                                                                                                                                                                                                                                                                                               | Done when                                                                                                                                                                                               |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **U1** | `tokens.ts` (light + night) → `globals.css` and `desktop/shell/tokens.css`; old tokens migrated and linted out; fonts bundled (`next/font/local`, overlay `@font-face`); Appearance and Text size settings; focus ring; `Button`, `Keycap`, `NebDot` (replacing `Mascot`); the copy pass; `/dev/ui` | Every state renders in both themes; the contrast test passes; snapshots recorded; no old token name left; every existing test passes                                                                    |
| **U2** | Page anatomy: `PageScreen`, `NebLane` + `NebNote` + `MarkConnector` (note words out of the canvas), `LevelSwitch`, `MarginFold`, `PencilCase` with hand placement, `ChapterTabs`, `ContentsDrawer`, `AskPill`; Notes Check restyle                                                                  | Live annotations from K9 render in the lane; Quiet / Hint / Coach and Fold behave per §4.3–4.4; tabs jump, rename and accept dropped pages; the K1 tree tests pass through the drawer                   |
| **U3** | `ReplayBar` with mark and moment ticks; `FilingToast` and its placement rules; `usePenCalm`                                                                                                                                                                                                         | Scrubbing redraws ink and notes in order; the toast never appears over the active line (tested with the pen in each third)                                                                              |
| **U4** | Desk: `TonightCard`, `UnsortedTray` + File these, `NotebookCover` (ribbon, sticky), Recent moments, naming flow, empty desk; the `stayed` migration and `notebook_stayed` view                                                                                                                      | First run shows the single dashed cover; a notebook can't be created unnamed; `notebook_stayed` feeds the ribbon (RLS test: another student's counts are invisible)                                     |
| **U5** | Show-then-You restyle: `SolutionStrip`, `YourTurnCard`, fold on pen-down, peek-as-hint, finish states                                                                                                                                                                                               | The strip folds on the first stroke in Your-turn, a peek is logged as a hint, and the checker ticks the student's lines (the existing flow tests pass unchanged)                                        |
| **U6** | Moments and checks: `CheckScreen`, moment column blurred until answered, `CheckCard`, `SpacingTimeline`, stayed events, session end                                                                                                                                                                 | A correct answer ≥ 24 h after saving sets `stayed_at` exactly once (retry test); "I don't know yet" grades `again` and the next due date is sooner                                                      |
| **U7** | Overlays: `CoachFrame` (indicator held open), status capsule, island restyle, lasso cursor, `SketchCard` + pointer line, `SavedStamp`; keytips (hold Alt); `ShortcutsSheet`; palette and picker restyle; onboarding; tray "Pause neb for 1 hour"                                                    | The frame is on for every capture (Rust test over capture call sites) and gone within 150 ms after; all 8 shortcuts work with ≤ 2 keys; onboarding completes in under 2 min or is skipped at every step |

**After each milestone:** run the unit (vitest, pytest, cargo), snapshot and keyboard tests plus
one Playwright flow per screen touched; stop any dev server started; commit on the milestone's
branch; report in 5 lines or fewer: what shipped, what's left, and any decision made.

---

## Decisions

Recorded on 2026-10-27, when the owner's brief was fitted to the code. They bind U1–U7.

1. **U1. This document wins over the boards.** The boards in `design/u/` are the look; where
   they show something the app doesn't do (the held-key frame, a 3-colour-only case, no lasso),
   the text here applies.
2. **U2. One violet.** `--neb #6B4EE6` / `#9C86FF` replaces `#8a7bf0` / `#a497ff` everywhere,
   including the Rust indicator, `screen/ink.rs` and the overlays. Stored strokes keep their old
   hex; `displayColor` maps `#8a7bf0` (and its highlighter) to `--neb` in both themes, and new
   tutor strokes store `#6B4EE6`. Tests that assert `#8a7bf0` are updated to the new constant.
3. **U3. Levels keep their data names.** Quiet / Hint / Coach map to `quiet` / `normal` /
   `coach`; `off` stays and is reached from the neb dot ("Turn neb off for this notebook") and
   "hide neb on this page" (which hides the marks layer on that page only). Quiet now draws
   ticks and "?" and hides error marks (counted on the dot) instead of K9's "errors only"; Coach's
   spoken nudge waits 45 s. Both are display/timing changes in `annotator.ts`; evidence logging
   is unchanged.
4. **U4. Words in the lane, marks on the page.** Note text is DOM, from the `Annotation` record;
   circles, underlines, arrows, ticks and "?" stay tutor strokes (synced, exported, replayed).
   Exports draw the lane. Old glyph-note strokes are left as they are.
5. **U5. The tree stays.** It moves into the Contents drawer; the desk and the tabs are the
   everyday way around, the drawer is for structure work.
6. **U6. The pencil case keeps the lasso, sizes, green ink and the highlighter colours** behind
   long-presses; the visible case matches the board.
7. **U7. Tokens have one source** (`packages/shared/src/ui/tokens.ts`); the overlay CSS is
   generated and checked.
8. **U8. Fonts are vendored woff2 files** with their licences, loaded with `next/font/local` and
   `@font-face`; no font packages.
9. **U9. Screen coach follows the island.** The frame shows whenever a capture is possible (Select
   session, a screen question's mic, a walkthrough), not on a held key, because the owner's island
   decision replaced hold-to-draw while Screen Coach is on. The keycap indicator shows only for the
   hold that remains (Screen Coach off or paused). The island keeps its black notch.
10. **U10. Stayed is stored, not recomputed per view:** `moment_checks.stayed_at`, set once by the
    grading path, and `notebook_stayed` over it. Only moment checks (including S6 quiz cards with
    a notebook) count.
11. **U11. The Tonight card adds rows the brief didn't know about** (skill re-checks on desktop,
    an exam within 7 days) in the order of §5.1, still at most 3.
12. **U12. Onboarding's handwriting step is K10's calibration** (it shipped before U started;
    see U17). "not wrong" logs a correction and teaches the profile, as K10 built it.
13. **U13. Notes Check findings are restyled, not moved into the lane,** in this series.
14. **U14. Courses, Review, Teach and Settings get the tokens, type and buttons only;** their
    layouts are out of scope. They're reached from the avatar menu.
15. **U15. "Archive"** on a cover's menu appears only if the tree gains an archived state; U adds
    none, so the menu is Rename, Colour, Subject, Delete.
16. **U16. Branches:** this series' spec was committed on `feat/ui-desk-overhaul`; K10 was built
    after it (`feat/notebooks-k10`), and U1 starts from K10 on `feat/ui-u1-tokens`. Each later
    milestone gets its own branch off the one before (`feat/ui-u2-page`, …), committed, not
    pushed.
17. **U17. K10 is in place before U starts.** The page has K10's "neb read: … · Fix" chip (a
    lassoed line) and the mark menu's "Fix what neb read"; U2 restyles both and moves the
    reading into the neb lane (§4.2). Settings → Handwriting and the calibration (K10) get the
    U1 tokens like the other settings sections; onboarding step 3 (§5.10, decision U12) can now
    use K10's `Calibration`.
18. **U18. Built in U1 (2026-10-28, `feat/ui-u1-tokens`).**
    - **Tokens:** `packages/shared/src/ui/tokens.ts` → `pnpm build:tokens` writes
      `frontend/src/app/tokens.css` and `desktop/shell/tokens.css` (both Prettier-ignored; a test
      fails when either is stale). Night is `:root[data-theme="night"]`, or the OS's dark mode
      unless `data-theme="light"`.
    - **Old names** were migrated by a codemod (570 uses in 67 files) and an ESLint rule
      (`no-restricted-syntax` in `frontend/eslint.config.mjs`) keeps them out. Hairlines are
      `border-line`; links, focus and hovers are ink; violet stayed only where neb speaks or
      acts (marks, the pointer, the hold's loop, neb's answers, checks due). Red (`danger`) stays
      only on destructive actions and developer pages: error messages are muted sentences, a
      wrong answer is a muted circle, notices and validation are ink pills.
    - **Fonts:** latin subsets from Fontsource 5.3.0 in `packages/shared/fonts` with their OFL
      licences, 152 KB in all; **Caveat has one weight (500)**, as its two came to 102 KB alone
      and it's only for mock ink and labels.
    - **Appearance and Text size** are kept in this device's localStorage (`lib/display.ts`) and
      applied by an inline script with the CSP nonce before the first paint; the canvas redraws
      its ink when night turns on or off.
    - **Ink colours:** the pens are the tokens' (graphite, blue, red; green kept); strokes stored
      in the old violet or pens draw in today's (`displayColor`). The desktop's violet (the
      capture indicator, `ink.rs`, the overlays) is `#6b4ee6`.
    - **Notebook colours:** the stored names stay (`slate`, `teal`, `blue`, `violet`, `rose`,
      `amber`, `green`) and show as the cover palette (violet shows as sky and isn't offered;
      suggestions never pick it). The cover palette's other names (clay, ink, sage, mustard) need
      the database change U4 makes with the covers.
    - **The mascot is gone:** `NebDot` (`components/ui/`) is in the dock; its states map from the
      session (sleeping → watching, muted → off).
    - **Copy:** `src/copy.test.ts` fails on "wrong", "incorrect", "error", "fail" or "easy" in any
      sentence a student reads (K9's "Not wrong" label is kept on purpose).
    - **`/dev/ui`** shows U1's components; `e2e/ui.spec.ts` screenshots each section in light and
      night (tolerance 30 pixels: a broken icon must fail) and checks focus, the desk colour and
      the Appearance and Text size settings across a reload.
19. **U19. Built in U2–U5 (2026-10-28; `feat/ui-u4-desk`, `feat/ui-u2-page`, `feat/ui-u5-show`).**
    - **Routes:** the desk is `/desk` (`NotebookApp start="desk"`); `/notebook` still opens the
      latest page, so deep links and the e2e flows keep working.
    - **The lane:** mark words leave the canvas (`planLiveMarkInk(..., words: "lane")`) and render
      as DOM notes in `NebLane`; ticks and "?" stay page strokes and tap targets. The K1 tree is
      the Contents drawer, open when this device's `localStorage["neb:contents"]` is `"1"`.
    - **Alt + C** checks the work, or unfolds the margin when it's folded. The Notes Check panel
      sits at the top right of the sheet, clear of the lane.
    - **Show-then-You:** solution records keep `steps`, `finalAnswer` and `verifiedBy`, so the
      strip shows the worked steps as text beside the taped your-turn card and folds at the
      student's first stroke. Records from before U5 have no steps and show no strip.
    - **Neb's pixel font** has ligatures off (`.neb-voice`): Pixelify draws "fi"/"ff" as a block.
20. **U20. Built in U6 (2026-10-28, `feat/ui-u6-checks`).**
    - **`QuickCheck.tsx` keeps its name and logic** (and its test ids); the layout is board 5's:
      the moment on the left, blurred until an answer or a tap, the index card on the right with
      progress bars, the serif question, `SpacingTimeline`, and the end line "N of N done · M
      stayed today". `CheckScreen`/`CheckCard` weren't split out: one file is the screen.
    - **"I don't know yet"** sends `dontKnow: true`: not graded (no model call), FSRS `again`, the
      answer shown with "that's fine".
    - **Stayed** is decided on the web server (`stayedFor` in `@mew/shared`: right, no peek, no
      hint, ≥ 24 h after the check was made) and returned as `result.stayed`; the PATCH carries
      `stayed: true` and FastAPI sets `stayed_at` only while it's null. Migration
      `20261111000000_stayed.sql` adds the column, a check that it's at least a day after
      `created_at`, a trigger that keeps the first time (a retry can't move or clear it), and the
      `notebook_stayed` view per root notebook (`security_invoker`). Until it's applied, marking
      and reading fail softly (logged) and nothing else changes.
    - **`GET /api/moments/stayed`** feeds the cover ribbons (board 1's white notched ribbon) and
      "stayed this week: N" on the Tonight card. Local mode counts per node; the web app adds both
      up its tree (`stayedByNotebook`). "Physics stayed 34 → 35" on the check card is not built.
21. **U21. Built in U7 (2026-10-28, `feat/ui-u7-overlays`).**
    - **The frame:** `indicator::Frame` holds the four edge windows open until it's dropped,
      then they fade in 150 ms. The coach keeps one while Select is on, the island's or card's
      mic is open, or a walkthrough runs (`CaptureReach`, refreshed with the island and the
      tray), on the island's monitor or the pointer's. Every capture holds its own frame on the
      captured monitor too: the pipeline's only pixel read takes a `FrameToken`, which only a
      frame on screen lends, and `every_capture_needs_the_frame` checks no other code reads the
      screen. The frame is the 4 px violet edge; the inner 40 px glow isn't drawn (layered
      windows are flat colour). The per-capture flash stays.
    - **Overlays** link `tokens.css` and `fonts.css` (`font-src 'self'`); `overlay.css` and
      `screen-coach.css` alias their old names to the tokens. The island keeps its black notch;
      its status is a small neb dot (breathing, three dots while looking, a ring while
      listening), only Select's pressed state is violet. The circle card is the sketch card
      (paper, violet top edge, `--sh-3`, pill buttons, the ask box as a pill, "neb · …" in pixel
      type); its saved state is the stamp (dashed edge inside a paper margin, the ✓ as a violet
      disc). Select's cursor is a dashed violet lasso (`lasso-cursor.svg`).
    - **Keys:** `KeytipsOverlay` and `ShortcutsSheet` are mounted in the notebook; Shift + ? or
      the ask pill's "?" opens the sheet. Controls with keys carry `data-keytip`.
    - **Jump palette and destination picker:** 640 px sheets, serif search, results grouped
      (Notebooks · Chapters · Pages · Moments) with the typed letters underlined and moment
      thumbnails; the picker shows this device's last 4 places as chips.
    - **Onboarding** stays a dialog (over the desk or page), in four skippable steps: the
      writing hand, K10's calibration, how much neb marks (this device's level for notebooks
      without their own, `defaultLevel` in the mark prefs), then Start listening. The first
      notebook is named on the desk's first-run cover (U4).
    - **Tray:** "Pause for 1 hour" pauses now and resumes in an hour unless the pause changed
      meanwhile; a restart in between keeps it paused.
    - **Not built in U7** (U8 and U9 build them): the status capsule and the hold's keys
      indicator, the sketch card's pointer line, the frame's inner glow, onboarding's desktop
      "Try it" step, the palette's "> " commands, the picker's "+ New chapter here" and
      "suggested: matched …", and "what can I say?".
22. **U22. Built in U8 (2026-10-28, `feat/ui-u8-coach-overlays`): what U7 left on the desktop.**
    - **The frame's glow:** a held frame adds four 10 px bands inside its 4 px edge, from 33 %
      violet fading inwards (40 px at 100 % scaling), each its own layered window; they fade
      out with the edge. A capture's flash has no glow.
    - **The status capsule** (`capsule.html`, `status.rs`): top-right of the frame's monitor,
      48 px in (clear of the glow), shown and hidden with the held frame.
    - **The keys indicator** (`keys-hint.html`): bottom-left of the pointer's monitor while
      Ctrl + Alt is held with Screen Coach off or paused; it goes when the keys come up or the
      hold is spoiled. Both pages have no script, call no commands, and are click-through,
      never focused and excluded from captures.
    - **The pointer line:** when the card shows beside the marks, the draw overlay draws a 3 px
      violet line from the card's nearest edge into the marks' box (`pointer_line`); it goes
      when the card does. It's set when the card is placed (the card doesn't move after).
23. **U23. Built in U9 (2026-10-28, `feat/ui-u9-keys-and-voice`): what U7 left in the app.**
    - **Ctrl + K, "> ":** the palette lists commands (check my work, new notebook, new chapter and
      page here, bring in a PDF, the desk, every shortcut) with their keys and what to say,
      narrowed by what's typed after ">". The commands that need a place show only when there
      is one.
    - **The destination picker** shows neb's suggestion first with why ("suggested: matched
      “vectors”", from filing's suggestions when a moment is filed by hand), and "+ New chapter
      here" (or section) on a row's hover or focus: named inline, made with `addChild`, and
      picked. Sections hold nothing, so their rows don't offer it.
    - **"What can I say?"** (and "what can you do?", "show me the shortcuts") is matched on the
      device (`asksWhatToSay` in `@mew/shared`) before the classifier: the sheet opens and the
      words go nowhere else. The trained labels are unchanged.
    - **Onboarding's "Try it"** (desktop app only): a sample slide with an arrow and "double tap
      Ctrl Alt, pick Select, and circle the arrow". It asks the desktop app through a new
      command, `screen_coach_onboarding`, which answers only whether Screen Coach is on and,
      when asked, opens its local settings page; the student turns it on there, with its consent.
      The web app still can't change a Screen Coach setting (decision 1).
24. **U24. The page matches board 2 (2026-10-28, `feat/ui-u10-board-fidelity`).** The owner found
    the page cluttered next to the board:
    - **The Contents drawer is the notebook tree only.** Courses, Review and Settings are on the
      desk's avatar menu; "Quiz me on this course" is a Ctrl + K command. The drawer opens from
      "Contents" under the chapter tabs; the header's ☰ is gone.
    - **The header** is back, where you are, one level pill (Quiet / Hint / Coach open from it),
      and Fold the margin.
    - **Under the sheet:** the replay bar, the page arrows, and one "⋯" holding zoom, the
      detected lines, neb's ink, export and the marks menu.
    - **The ask pill** has no "?" (Shift + ?, Ctrl + K and "what can I say?" open the sheet) and
      shows the debug toggle only when `localStorage["neb:debug"]` is "1" (the e2e fixture sets
      it).
    - **neb's pointer** shows only while neb writes, as a violet nib; the old Mew cat is gone.
    - **Next's development badge** is off (`devIndicators: false`); it was the black circle in
      every page's corner.
25. **U25. Review gets a new layout (2026-11-04, `feat/ui-u10-review`; boards 7 and 8).** This
    overrides U14 for Review only; Courses, Teach and Settings still keep their layouts.
    - **Header:** the desk's: ‹ Desk, neb's mark, the jump search and the avatar menu. The jump
      palette needs the notebook tree, so the search (and the jump key on Review) opens
      `/desk?jump=1`, which opens the palette on the desk.
    - **Left column, "Up next":** the index card for moment and screen-quiz checks (Start is the
      neb button; it opens the existing Quick check), then Skills to re-check (`SkillsCard`, shown
      empty as board 8's "None due" card). Board 8's "Not now" and the source thumbnail aren't
      built: Not now has no behaviour behind it, and the check's moment stays hidden until the
      student tries.
    - **Right column, the folders:** one folder per course with started concepts or reviews due,
      tinted with the cover colour of the course's notebook on this device (a stable cover colour
      from the course id when there's none). Tabs sit in fixed slots, ordered by most to revisit,
      then most new; a course with an exam close still comes first. A picked tab pulls its folder
      up and drops it in front (`folder-pull-out`, 640 ms); reduced motion swaps. Past 7 courses a
      "More" tab lists the rest, and one picked from it takes the last slot. Arrows, Home and End
      move between tabs.
    - **Rows:** every concept the student has started, from `conceptStatus`: revisit (ink disc ↺),
      explored as new (dashed ring), checked (violet-washed disc ✓), in that order. Practised with a
      hint isn't checked, so it shows between new and checked as "With a hint" (washed disc, muted
      ✓). Never-opened concepts aren't listed.
    - **Quiz me** per course is the existing quiz (`quizHref`); its count is the course's concepts
      in the review queue, as before.
    - **Unchanged:** behaviour, data and FSRS (no API change: the page reads the course list, each
      course's detail and progress, and the review queue). No score line.
    - **Previews:** `/dev/ui`'s Review and Review · many courses sections, screenshotted in light
      and night by `e2e/ui.spec.ts`, which also tests the tabs and More.
26. **U26. A notebook is the whole class; Review stays the one place for what's due
    (2026-11-04, the owner's request; `feat/ui-u26-study`, then `feat/ui-u26-review`).** Courses
    and notebooks were two things to find; students think of one, "my DSA class". This overrides
    U14 for Courses, and U25 where it names courses.
    - **No Courses page.** `/courses` goes to the desk; `/courses/<id>` opens the course's
      notebook on its Study tab (making the notebook, as `/notebook?course=` always did, for a
      course that has none). Lessons keep their pages.
    - **A notebook's home has at most three tabs:** Pages (always; "Contents" before), Study (on
      the notebook itself, once it has course material: what the course page showed, its build
      progress, the scope review, the study plan, the exam date and Quiz me) and Moments (once
      something was saved, and always in Unsorted). Chapters have no Study tab: the course is the
      notebook's, and chapter cards keep their progress.
    - **Until a notebook has material,** one card on its Pages tab says what adding it unlocks.
      "Add course material" is the PDF import, whose "Use as course material" (on by default)
      makes and links the course (K4). A course made before this, on the old page, can be picked
      from the same card ("Use a course you have…"); a deleted course unlinks.
    - **"Review topics"** opens the Study tab instead of the course page.
    - **Review** keeps its look (U25); built in `feat/ui-u26-review`:
      - **Its folders are notebooks:** a course's folder takes its notebook's name and cover
        colour; a notebook with checks due from saved moments and no course gets a folder with
        "N quick checks from what you saved here" and Start (its own Quick check); a course no
        notebook links keeps its own folder. Tabs order by revisit, then new, then checks due; a
        tab's count is its quiz plus its checks.
      - **It's reached from the desk's header:** a Review button, with what's due (checks plus
        course concepts in the review queue) and no count when nothing is. The avatar menu keeps
        Teach neb, Settings and the account.
      - **The Tonight card** gains "N concepts to review" (Review) after the quick checks, still at
        most three rows.
    - **Unchanged:** the data. Courses, concepts, attempts and FSRS stay as they are; a notebook
      still links to a course by `courseId`.
