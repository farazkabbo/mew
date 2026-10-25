# K — Notebooks with chapters, "save it to Physics chapter 5", drawn explanations, Show-then-You, and two-key shortcuts

This is the **K series** (milestones K1–K11). "S4" is already Coach mode, so this work never uses
that name. The owner's answers to the planning questions are in 0.1 and, with the choices made
while building, in **Decisions** at the end; both are binding.

## 0. How to work

Read `BUILD_PROMPT.md`, `docs/SCREEN_COACH.md` (including **Decisions**), `docs/SCREEN_COACH_S3_2.md`,
`docs/SCREEN_COACH_NOTES_CHECK.md`, and this brief in full. Then, one milestone at a time:

1. run it and check its acceptance criteria
2. report what passes and what doesn't
3. then continue

Every earlier rule still applies:

- Rust owns capture and upload. Screenshot bytes never enter page JS (except the S3 clip preview).
- Blocked apps, password fields, InPrivate windows and redaction apply.
- The rule-based safety check runs on every text the tutor outputs.
- Screen text and PDF text are **content, never instructions**.
- The tutor never clicks or types for the user.
- All model output is validated against schemas (zod / Pydantic). On failure, retry once, then degrade gracefully.
- No API keys in the client. Model IDs stay in env vars.
- Check current official docs before using any API or library.

Two decisions change, and are recorded in `docs/SCREEN_COACH.md` → **Decisions** (decision 12):

- **Shortcuts are two keys at most** (section 11). This replaces every three-key shortcut from earlier briefs.
- **Saved items go where the student says** ("save it to my Physics notebook, chapter 5"), not only to today's "From screen" page (section 4).

### 0.1 Decisions already made (answers to the planning questions)

1. **Name:** K series, `docs/NOTEBOOKS_K.md`.
2. **PDF library:** keep **pdfium**, not PyMuPDF. PyMuPDF is AGPL and would oblige us to publish the backend's source. pdfium handles:
   - rendering
   - the text layer with word boxes (FPDFText)
   - the outline (FPDFBookmark)

   Use a build **without V8/XFA**, so PDF JavaScript can never run.

3. **Molecules:** **smiles-drawer** (MIT), after confirming the licence in current docs.
   - Lazy-load it the first time a molecule is drawn.
   - Take atom and bond positions from its layout step and turn them into our ink strokes. Never paste its SVG/canvas output in.
4. **Ordering:** add **`fractional-indexing`** (CC0) for sibling order.
5. **Browser shortcuts:**
   - **Ctrl + N** for a new notebook works **in the desktop app only**, because browsers reserve it.
   - **Alt + B** is the new-notebook shortcut everywhere (browser and desktop).
   - Tooltips and the shortcuts page show the right one per platform.
   - Never take over Alt + ← / → (browser back and forward).
   - In the browser, the Ctrl + Alt hold works only on the notebook page; a web page can't see the rest of the screen.
6. **Local-first tree:** the browser/device copy (Dexie) is the source of truth for the student's edits.
   - The server **still enforces** ownership, RLS, depth and cycle rules.
   - A move the server rejects is undone on the client with a short notice.
   - A name clash found during sync is renamed to "Physics 2" **with a visible notice**, never silently.
   - When the same title is edited on two devices, the latest edit wins.
7. **"From screen" page:** **one per node, not one per day.** Entries stack with a **date heading** whenever the day changes. After about 30 entries, continue on "From screen 2".
8. **PDFs in a notebook with no course:** **create a course automatically.** Learning tracking is the core of neb, so a PDF should never be just pages to write on by default.
   - The checkbox reads _"Use as course material (creates a Physics course)"_, default **on**. Students turn it off for non-study PDFs.
   - The course is linked to the notebook, and each chapter becomes a course section.
   - Concept extraction runs in the background. Don't force the scope-review screen during import; show a "Review topics" card on the notebook home when it's ready.
9. **Offline PDF pages:** cache pages **as they're viewed**.
   - The image and text layer go in IndexedDB, up to about 300 MB, evicting the least recently used. Call `navigator.storage.persist()`.
   - Add **"Make available offline"** on each PDF and each chapter.
   - The desktop app stores these in its app data folder.
   - The student's handwriting on PDF pages always works offline. A page that isn't cached shows: "Connect to load this page — your notes on it are safe."
10. **Auto-filing (section 4.6):** when the student doesn't say where to save, neb files the moment by **what they're studying**, not by whichever notebook happens to be open. For example, a physics video goes to Physics › the matching chapter. The toast always shows where it went, and **Change** teaches it.
11. **Every saved moment gets quizzed (section 4.7).** Each saved screen moment schedules a check question in review.
    - This **replaces** the S3.2 rule that concepts got a review card only after a misunderstanding.
    - Asking still isn't mastery evidence, but answering the later check correctly on your own is.
12. **Live annotations (section 7):** while the student writes, the tutor marks each finished line (ticks, error circles with short hints, missing-unit arrows), silently by default. Marks are **saved automatically** as tutor strokes; there's no save button. When neb is unsure what it read, it **never** makes an error mark.
13. **Handwriting (section 8):** improve recognition in this order: measure with an eval set, read better with context and logic, personalize to each student from their corrections, and only later train our own model with opt-in consent.

---

## 1. What we're building, in one paragraph

Notebooks get **structure**:

- A student names a notebook while creating it.
- They can add chapters (sub-notebooks) inside it, for example a Physics notebook with 4 chapters.

Anything the tutor explains can be **saved to the exact place the student names**, by voice or typing: "save it to my Physics notebook, chapter 5". This covers circled content on screen (a YouTube frame, a PDF, a web page) and PDFs they upload. Two things change in how the tutor explains:

- It doesn't just mark up existing content. It **draws what helps**: a benzene ring, a right triangle with its right-angle marker, a force diagram. This happens on screen and inside the notebook.
- When a student asks for the answer directly, the tutor **shows every step with the reason for each one**. Then it says **"your turn"**: it folds the solution away, gives a similar problem, and checks the student's handwritten attempt.

Every shortcut is **two keys or fewer**.

---

## 2. Notebooks and chapters

### 2.1 Structure

```
Notebook            e.g. "Physics"
 ├─ Chapter         e.g. "Chapter 1 · Kinematics"
 │   ├─ Section     (optional third level, e.g. "1.2 Projectile motion")
 │   └─ Pages
 ├─ Chapter …
 └─ Pages           (loose pages directly in the notebook are allowed)
```

- **Maximum depth: 3** (notebook › chapter › section). Pages can live at any level.
- Each notebook chooses what its second level is called: **Chapters** (default), Units, Weeks, Topics or Modules. The UI uses that word ("New unit"). The destination resolver (section 4) accepts all of these words as synonyms.
- Sibling names must be unique, ignoring case. Voice routing needs this. On a clash, suggest "Physics 2".

### 2.2 Creating a notebook, named at creation

Start: **Alt + B** (everywhere), **Ctrl + N** (desktop app only), or **+ New notebook** in the sidebar.

1. A new row appears in the sidebar tree with its name field **already in edit mode**. "Untitled notebook" is selected, so typing replaces it.
2. A small creation popover opens beside it:
   - **Name** (focused; 1–80 characters, trimmed)
   - **Icon and colour**, suggested from the name ("Physics" → ⚛ teal); can be changed
   - **Link to a course** (optional; lists the student's courses)
   - **Chapters** (optional), in three ways:
     - **Type them:** a quick-add list. Type a name, press Enter, and the next row appears. Drag to reorder.
     - **Just a number:** "Chapters: [4]" creates "Chapter 1" to "Chapter 4". Each name can be edited right there before creating.
     - **From a PDF or syllabus:** pick a file. The PDF's table of contents (or, for a linked course, the course's concept outline) is proposed as chapters. The student can rename, uncheck or merge them before creating.
3. **Enter** creates the notebook. **Esc** cancels and nothing is created.
4. The notebook opens on its **home view**:
   - chapter cards showing title, page count, last edited and course progress (if linked)
   - "Loose pages"
   - an **+ Add chapter** card

### 2.3 Working with the tree

- **Rename:** F2, double-click, or right-click → Rename. Undoable. Voice also works: "rename this chapter to Optics".
- **New chapter in the current notebook:** **Alt + N**, or the "+" on hover, or the context menu. The name field opens in edit mode, the same as for a notebook.
- **New page here:** **Alt + P**.
- **Move:**
  - drag and drop in the sidebar
  - **Alt + ↑ / ↓** to reorder siblings
  - "Move to…" opens the same destination picker used for saving (section 4.4)
- **Delete:** soft delete to **Trash for 30 days**, with an Undo toast. If the item has children, the confirmation shows how many ("Delete _Physics_ with 4 chapters and 23 pages?"). Voice never deletes.
- **Breadcrumb** on every page header: _Physics › Chapter 5 › Page 3_. Each part is clickable.
- **Ctrl + K** opens a jump palette: fuzzy search across notebooks, chapters, sections and pages.
- **Tutor context:** retrieval, Notes Check (S3.5) and the learner model look at the **current chapter first**, then the notebook, then the linked course.

### 2.4 Data model (migrations, with RLS)

Extend `notebooks` into a tree. Don't create a separate table per level.

```sql
alter table notebooks
  add column parent_id   uuid references notebooks(id) on delete cascade,
  add column root_id     uuid,                    -- self for roots; maintained by trigger
  add column depth       smallint not null default 0 check (depth between 0 and 2),
  add column position    text not null,           -- fractional index (e.g. `fractional-indexing`)
  add column child_label text not null default 'Chapters',
  add column icon text, add column color text,
  add column deleted_at  timestamptz;
create unique index notebooks_sibling_name
  on notebooks (user_id, coalesce(parent_id, '00000000-0000-0000-0000-000000000000'), lower(title))
  where deleted_at is null;
```

Triggers and policies:

- **The trigger enforces:**
  - the parent belongs to the same user
  - depth ≤ 2
  - no cycles
  - `root_id` and `depth` are kept correct on insert and move
- **Existing rows:**
  - `pages.notebook_id` now points at any tree node
  - existing notebooks become root nodes (depth 0); no data is lost
- **New node columns:**
  - `chunks` gets a nullable `notebook_node_id`, for chapter-scoped retrieval
  - `screen_entries` gets the destination node
- **RLS** on every touched table: users only see and change their own rows. A child's `user_id` must equal its parent's.
- **Local-first (decision 0.1 #6):**
  - The Dexie copy is the source of truth for edits and syncs to the server.
  - The server re-checks ownership, depth, cycles and sibling uniqueness on every write.
  - Rejected moves revert on the client with a notice.
  - Name clashes are renamed to "Physics 2" with a visible notice.
  - Titles use latest-edit-wins.
  - Reorders use `fractional-indexing`, so offline moves merge cleanly.

---

## 3. Explaining by drawing (screen and notebook)

### 3.1 What changes

In S3.2 the tutor annotated what was already there: underline, circle, margin notes. Now it can also **draw a new figure when a figure explains better than words**. Examples:

- "Why is this the hypotenuse?" → it draws a right triangle, marks the right angle with the small square, labels the sides a, b and c, and highlights c opposite the right angle.
- "What are these carbon rings?" → it draws a benzene ring with its six carbons and alternating double bonds (or the aromatic circle), then labels one C–H.
- "Why does the block slow down?" → it draws a force diagram: box, arrows for F, f, N and mg.

### 3.2 Where it draws

- **On screen:** figures go in a **sketch card**. This is a small paper-coloured card (about 320 × 240 px, resizable) placed beside the student's circle using S3's placement rules. Drawing freehand over someone's video or PDF is unreadable, so figures don't go directly on the content. Arrows from the card may point _into_ the circled area.
  - The card is excluded from capture, like all overlays.
  - It's saved into the notebook entry as tutor strokes next to the crop.
- **In the notebook:** figures are drawn as ink in free space next to the problem (existing placement engine).

### 3.3 New board actions (shared by the notebook renderer and the screen overlay)

**The model describes; code constructs.** The model never sends raw coordinates for figures that have rules.

```ts
type GeometrySpec =
  | { kind: "triangle";
      given: { a?: number; b?: number; c?: number; A?: number; B?: number; C?: number }; // sides / degrees
      rightAngleAt?: "A" | "B" | "C";
      labels?: Partial<Record<"A"|"B"|"C"|"a"|"b"|"c", string>>;
      show?: ("right_angle_marker" | "angle_arcs" | "side_labels" | "height")[];
      highlight?: ("a"|"b"|"c"|"A"|"B"|"C")[] }
  | { kind: "circle"; show?: ("radius"|"diameter"|"chord"|"tangent")[]; labels?: Record<string,string> }
  | { kind: "polygon"; sides: number; regular: true; labels?: string[] }
  | { kind: "angle"; degrees: number; label?: string }
  | { kind: "coordinate_points"; points: { label: string; x: number; y: number }[]; connect?: boolean };

type BoardAction =
  | /* …existing actions… */
  | { type: "draw_geometry"; figure: GeometrySpec; anchor: Anchor }
  | { type: "draw_molecule"; smiles: string; aromaticStyle?: "kekule" | "circle";
      highlightAtoms?: number[]; atomLabels?: { index: number; text: string }[]; anchor: Anchor }
  | { type: "point_at"; target: TargetRef; note?: string }          // notebook: line/stroke group; screen: box
  | { type: "underline" | "circle_region"; target: TargetRef };     // now also for notebook lines
```

How each figure type is built:

- **Geometry:** solve the figure in code (law of sines/cosines; default size when lengths are missing), then scale it to the anchor box.
  - Reject impossible specs, such as a triangle that breaks the triangle inequality or angles that don't sum to 180°.
  - Draw with the hand-drawn renderer (roughjs → strokes), with the right-angle marker as a real small square.
- **Molecules:** parse and lay out SMILES with **smiles-drawer** (MIT; confirm the licence).
  - Lazy-load it on first use.
  - Use its layout coordinates for atoms and bonds; never its rendered SVG/canvas.
  - Turn bonds and atom labels into ink strokes, drawn bond by bond.
  - If the SMILES is invalid, drop the figure and explain in words.
- **Force diagrams, flowcharts, plots:** reuse `draw_shapes`, `draw_graph` and `draw_plot`.
- **Timing:** each figure animates as part of a step (the S3.2 rule: **draw first, then say it**).
- **Prompts:** update the tutor and `circle_ask` prompts so the model knows when a figure helps ("a picture of the thing being asked about, kept simple"). The model only uses these actions; it never invents new ones.

---

## 4. "Save it to my Physics notebook, chapter 5"

### 4.1 What can be saved where

| What                                                           | How it's saved                                                                                                                                                                                                              |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A Circle & Ask session on screen                               | The S3.2 `ScreenEntry`: clean crop, the student's marks as strokes, tutor ink by step, sketch-card figures, a text note, and the source (YouTube timestamp, page title, or **PDF file name + page number** when detectable) |
| A circle with no question ("save this to Chemistry chapter 2") | A clip only: crop + the student's marks + source (S3 clip pipeline)                                                                                                                                                         |
| An explanation of an uploaded PDF page inside neb              | The same entry shape, using the PDF's text layer instead of OCR                                                                                                                                                             |
| A whole uploaded PDF                                           | Imported as pages into the named notebook or chapter (section 5)                                                                                                                                                            |

### 4.2 When the student can say it

1. **With the question:** "Explain this and save it to Physics chapter 5." The destination is taken out of the question and isn't sent to the model as part of it.
2. **During the explanation:** "Save it to Physics chapter 5" is a **command, not a barge-in**. The explanation keeps going and the destination chip updates.
3. **After the explanation** (while the toast is up, or during the 2-minute follow-up window): the already-saved entry **moves** there. It is never duplicated.
4. **Without any explanation:** circle something, then say or type "save this to …".

Typing works the same way in the ask bar ("save to physics ch 5"). There's also a **destination chip** in the ask bar and caption card: _Saving to: Physics › Chapter 5 ▾_.

### 4.3 Destination resolver (`/packages/shared/destinations`)

Use deterministic matching first. Call a model only as a fallback.

1. **Normalize the phrase:**
   - lowercase it
   - drop "my", "the", "notebook", "folder", "please"
   - convert number words and ordinals to digits ("five" and "fifth" → 5; "ch5", "chap. 5", roman numerals after a level word)
   - map the level words chapter, unit, week, topic, module, section and lesson
2. **Split into path segments** using the level words and "in/of/under". All of these become [physics] › [chapter 5]:
   - "physics chapter 5"
   - "chapter 5 of physics"
   - "the kinematics chapter in physics" → [physics] › [kinematics]
3. **Score each node** along its ancestor path:
   - **Title similarity** per segment (trigram or Jaro–Winkler).
   - **Number match:** strong if the title contains the number ("Chapter 5", "5. Kinematics"); weaker if the node is simply the 5th child.
   - **Boosts:** for the currently open notebook and for recent destinations.
4. **Decide:**
   - **Top score ≥ 0.85 and ≥ 0.15 above the next:** save there.
   - **Close candidates:** show up to 3 chips ("Physics › Chapter 5" · "Physics II › Chapter 5"). Never guess.
   - **Nothing ≥ 0.5, or the chapter doesn't exist** (e.g. Physics has only 4 chapters): "There's no Chapter 5 in Physics yet. **Create it and save** · Pick another." Notebooks and chapters are **never created without this one tap**.
5. **Model fallback** only for descriptive phrases ("the one about forces"):
   - Send node IDs + titles only (no content) to `GEMINI_GATE_MODEL`, with a schema whose answer is an **enum of those IDs** or `null`.
   - Check that the returned ID exists and belongs to the user.
6. **Target page inside the node:**
   - default: that node's **"From screen"** page. There is **one per node, not one per day**. It's created on demand; entries stack with writing space under each, with a **date heading** whenever the day changes. After about 30 entries, new ones go to "From screen 2".
   - "on page 3" → that page
   - "on a new page" → a new page
7. **Sticky destination:** after a save, later saves from the **same source** (same PDF file or same video) default to the same place for 2 hours. The chip shows it, so it's never hidden.

```ts
type ResolvedDestination = {
  nodeId: string;
  path: string[]; // ["Physics", "Chapter 5"]
  page: { kind: "from_screen" } | { kind: "new" } | { kind: "existing"; pageId: string };
  confidence: number;
  method: "exact" | "fuzzy" | "model" | "picker" | "sticky" | "default";
};
```

### 4.4 Picker and toast

- **Destination picker:** a searchable tree with recent destinations on top and "+ New chapter here" inline.
  - Opens with **Ctrl + D** in the ask bar, or by clicking the chip, toast or "Move to…".
- **The S3.2 toast** now says where the item went:
  > ✓ Saved to **Physics › Chapter 5** — **Undo** · **Change** · **Open**
  - **Change** moves the entry.
  - **Undo** removes it, as before.
- **Default destination** when nothing is said: **auto-filing** (section 4.6). It no longer means "whatever notebook is open".

### 4.5 Mew changes

- **New labels:**
  - `save_to_notebook` (with `destinationPhrase`)
  - `notebook_command` (create, rename or move by voice; always confirmed with an undo toast; no deleting)
  - `show_full_solution` (section 6)
- **`MewOutput` gets an optional `destinationPhrase?: string`.** One utterance can carry both a question and a destination. Don't make a second model call to split them.
- **Not mastery evidence:** saving and organizing (as with asking in S3.2). Each saved moment does schedule a check (section 4.7), and _that_ answer counts.
- **New phrase:** "quiz me on what I saved today" (or "…this week", "…in Physics") opens a Quick check (4.7) filtered that way.

### 4.6 Auto-filing: saved to the notebook for what you're studying

Say a student is watching a physics lecture and circles a graph, without saying where to save it. The moment should land in **Physics**, in the chapter that covers that topic, so it's where they'll look for it later.

**Signals.** Use only data we already have; **no extra screen capture and no extra model call for the answer**:

- **The answer itself.** Add `subject` and `conceptHints` to `CircleAskResponse`, filled in the same call that answers the question.
- **Content match.** Embed the question, the summary and the crop's OCR text, and match against:
  - the student's course chunks and concepts, scoped by `notebook_node_id`
  - the text of their earlier moments in each chapter
- **Subject match.** Add a nullable `subject` column to `notebooks`, suggested at creation from the name and editable. Compare it with the answer's `subject`.
- **Source memory.** If an earlier moment from the **same source** was filed (or the student moved it), file this one there too. Same source means the same YouTube video ID, PDF file name or site and path.

**Order of precedence:**

1. A destination the student said or typed (section 4.2)
2. Source memory, including the student's past corrections for this source
3. Content match ≥ 0.80 → that chapter (or section)
4. Subject match only (notebook clear, chapter not) → that notebook's top-level "From screen" page, with chapter suggestions as chips in the toast
5. Sticky destination (4.3 step 7)
6. Otherwise → a system **Unsorted** notebook. It can't be deleted, and it's shown with a count in the sidebar. The toast asks _"Where should this go?"_ with chips and **+ New notebook: Chemistry** (pre-filled from `subject`).

**Rules:**

- **Never create a notebook or chapter without a tap.**
- **The toast says why:** _✓ Saved to **Physics › Chapter 3** · matched "projectile motion" — Undo · Change · Open_
- **Change teaches.** It records source → destination and down-weights the content match for similar moments. Store the correction as data on the user's account; don't fine-tune anything.
- **Batch tidy:** the Unsorted notebook offers "File these" with a suggested destination per moment, accepted one by one or all at once.
- **Privacy:** filing runs server-side on text we already had, against the user's own titles and embeddings. Only IDs, scores and the method used are logged.

```ts
type FilingDecision = {
  destination: ResolvedDestination; // from 4.3
  method: "spoken" | "source_memory" | "content_match" | "subject_match" | "sticky" | "unsorted";
  score: number;
  matchedLabel?: string; // e.g. "projectile motion", shown in the toast
  alternatives: ResolvedDestination[]; // up to 3, for chips
};
```

### 4.7 Moments: revisit the exact moment, and get quizzed on it

Every saved screen entry is a **moment**: what was on screen, what the student asked, and how neb explained it, linked back to the exact spot it came from.

**Revisit:**

- **Open source** jumps back to the exact spot:
  - **YouTube:** the video at the exact second (`&t=`). Other sites that support timestamps get the same.
  - **A PDF imported into neb:** that page, with the circled area highlighted.
  - **An external PDF:** the file name and page number. If the same file is later imported, the moment links to that page.
  - **A web page:** the URL with a text fragment (`#:~:text=`) that scrolls to the circled text.
  - **Other apps:** the app name and window title only.
  - All of this follows the S3.2 "Include source link" setting.
- **Replay:** the explanation redraws itself step by step **with the original voice**. Store each entry's TTS audio clips with it (Storage, up to about 60 s per entry), so replay costs nothing and sounds the same. Without stored audio, replay uses captions.
- **Moments list:** every notebook and chapter home gets a **Moments** tab: thumbnail, question, date and source icon. It's filterable and searchable, and `Ctrl + K` finds moments too.

**Quizzed on it:**

- **Check question.** The answer call also returns one check question per moment, at no extra cost:
  ```ts
  checkQuestion?: { prompt: string; kind: "short" | "mcq" | "work";
                    choices?: string[]; answerKey: string; conceptIds?: string[] }
  ```
  - **Math, physics and chemistry:** the answer key is verified with the checker router before it's stored. If verification fails, store no question (the concept still gets a normal review card).
  - **The question tests the idea, not recall of the screen.** For example, "Why is the slope of this graph the acceleration?", not "What colour was the line?"
- **Scheduling:** each check becomes an FSRS review card linked to the moment, so the first check comes about a day later and then spaces out.
  - Moments about the **same concept** in the same week merge into one card.
  - At most **15 new moment cards per day**; extras wait in a queue.
  - Exam dates still take priority.
- **Where the checks show up:**
  - **Review** (as today)
  - a daily **Quick check** of 3–5 questions, mostly from recent moments
  - a "2 checks due" badge on the chapter home
  - Desktop notifications are **opt-in** (default: in-app only).
- **Answering:**
  1. The question appears first, **without** the moment (retrieval practice).
  2. The student answers by typing, speaking, or writing on a quiz page. The checker router grades it.
  3. Afterwards they see _"From your moment on Tue"_ with a thumbnail, **Replay** and **Open source**.
  4. **Wrong answer:** a short explanation, a link to replay the moment, and the card comes back sooner.
- **Evidence:**

  | Result                           | Evidence                                      |
  | -------------------------------- | --------------------------------------------- |
  | Correct with no peek and no hint | `independent` (counts toward mastery)         |
  | Correct after a peek or hint     | `with_hint`                                   |
  | Wrong                            | Logged as an attempt; the card is rescheduled |

- **Setting:** "Quiz me on things I save" (default **on**). Turning it off stops new moment cards; existing ones can be kept or cleared.

---

## 5. PDFs into notebooks and chapters

### 5.1 Importing

**Entry points:**

- drag a PDF onto a notebook or chapter in the sidebar, or onto an open page
- the **Import PDF** button
- **Ctrl + O**

**Import dialog:**

- **Destination:** prefilled with where it was dropped or the current chapter; changeable with the picker. Typing "physics ch 5" uses the resolver.
- **Pages:** All, or a range ("40–62").
- **Split into chapters using the PDF's contents.** Shown only if the PDF has an outline. It previews the chapters, each becoming a sub-notebook. The student can rename or uncheck them, and the dialog shows which pages go where.
- **Use as course material** (default on): ingests the PDF for retrieval, scoped to the destination chapter.
  - If the notebook has no course, the label reads _"Use as course material (creates a Physics course)"_, and a course is created and linked automatically. Each chapter becomes a course section.
  - Concept extraction runs in the background. A "Review topics" card appears on the notebook home when it's ready; the import never stops for scope review.

**Result:**

- Each PDF page becomes a notebook page with the PDF as a **locked background layer** (rendered image + text layer). The student writes on top.
- The tutor annotates, draws and checks on these pages like any other page.

### 5.2 Implementation

- **Storage:** upload to `pdfs/{user_id}/{uuid}.pdf` (private bucket, RLS, short-lived signed URLs).
- **Validate:** magic bytes, size and page limits (env: 100 MB / 400 pages by default). Encrypted PDFs get a clear "can't import password-protected PDFs" message.
- **FastAPI job (pdfium, a build without V8/XFA), run with a timeout and a memory limit, and never executing PDF JavaScript.** Don't add PyMuPDF; it's AGPL.
  - render pages to WebP at 2× (lazily for big files: first 10 pages right away, the rest in the background with progress)
  - extract text with word boxes (FPDFText) and the outline (FPDFBookmark)
  - create `pages` rows with `background: { type: "pdf", sourceId, pageIndex }`
  - chunk and embed with `notebook_node_id`
- **Scanned pages:** if there's no text layer, offer "Recognize text" (Gemini, costs credits). Without it, those pages are still writable, just not searchable.
- **Circle & Ask on a PDF page inside neb:** use the PDF text layer and the rendered image directly. No screen capture or OCR needed; privacy filters don't apply because it's the student's own file in neb.
- **PDF text is untrusted content:** injection tests apply (section 12).
- **Offline:**
  - Cache each page's image and text layer **as it's viewed**, in IndexedDB, up to about 300 MB, evicting the least recently used. Call `navigator.storage.persist()`.
  - **"Make available offline"** on a PDF or chapter downloads all its pages.
  - The desktop app uses its app data folder instead.
  - The student's strokes on PDF pages always work offline. An uncached page shows: "Connect to load this page — your notes on it are safe."

---

## 6. Show-then-You: when the student asks for the answer

Hints first stays the default. This flow runs when the student **explicitly asks for the answer**:

- "just give me the answer", "solve it", "what's the answer to number 3"
- or when they accept the tutor's offer after **2 unsuccessful tries**

### 6.1 The flow (in the notebook)

1. **Find the problem.** Use the problem region next to the student's work (line segmentation), or the item they circled.
2. **Solve and verify before showing anything.** The model returns structured steps; code verifies them:
   - **Algebra/calculus/physics:** SymPy checks every step against the previous one (equivalence) and checks the final answer, with units through `sympy.physics.units`.
   - **Chemistry equations:** the atom/charge balance checker.
   - **Code:** run in Pyodide against the stated or expected output.
   - **Other subjects:** rubric check grounded in course material.
   - **If verification fails:** regenerate once. If it still fails, don't show a confident wrong solution. Say what's uncertain and fall back to hints.
3. **Show every step with its reason.** The **tutor pointer** (6.3) moves to each spot and writes the step in ink below or beside the problem. The caption and voice give the **why**, not just the operation:
   - writes `3x = 12`, says: "Subtract 7 from both sides, to undo the + 7."
   - writes `x = 4`, says: "Divide both sides by 3, to get x alone."
   - The final answer is boxed. Diagrams (section 3) are used whenever they help.
4. **Fold the solution.** It collapses into a tab, _Solution · tap to peek_. Peeking is allowed and is recorded as a hint.
5. **Your turn.** The tutor writes a **similar problem** in a "Your turn" box with space below:
   - same skill and structure, different numbers or context (e.g. `5x − 4 = 21`)
   - its answer key is **verified the same way** before it's shown
6. **The student solves it by hand.** Checking starts on a pen pause, on "check", or on **Alt + C**. It's line by line through the checker router:
   - **Correct line:** ✓ tick.
   - **Wrong line:** circled, with the smallest useful hint.
   - Unlimited tries. After 2 misses on the same line, offer a hint step.
7. **Finish.** "You got it on your own." Then offer **One more** (another variant) or **Back to your work**.
   - **Skip for now** is allowed. The problem goes to the review queue instead of counting as practised.

### 6.2 On screen (Circle & Ask)

"Just tell me the answer" on circled content runs the same flow:

1. The **steps with reasons** are annotated on screen. Figures go in the sketch card.
2. The entry is saved to the destination (section 4) with the worked solution **folded**, plus a **Your turn** box with writing space.
3. The caption ends with: _Your turn is in Physics › Chapter 5 — Open_.
4. Checking happens in the notebook.

### 6.3 The tutor pointer inside the notebook

- The same Mew pointer from S3.2 now also lives **in the notebook canvas**.
- It rests docked by the mascot. Before writing, it **glides to the spot**, and ink comes out of its tip, so the student's eyes follow the work.
- It points at, underlines and circles the **student's own lines** (via `note_lines` IDs and stroke groups), not just empty space.
- It respects reduced motion: no gliding, it just appears at the spot.
- **Hold Ctrl + Alt inside the notebook** works like on screen: circle part of your own writing and talk or type. Strokes and `note_lines` are used directly, with no screenshot.

### 6.4 Schema

```ts
type FullSolution = {
  problem: { text: string; latex?: string };
  subject: string;
  steps: { work: string; latex?: string; why: string; actions: BoardAction[] }[]; // why ≤ 20 words
  finalAnswer: { text: string; latex?: string };
  yourTurn: {
    problem: string;
    latex?: string;
    answerKey: { text: string; latex?: string };
    skill: string;
    conceptIds?: string[];
  };
};
// Added by code after verification, never by the model:
type VerifiedSolution = FullSolution & {
  verification: {
    method: "sympy" | "chem_balance" | "code" | "rubric";
    passed: boolean;
    failedStep?: number;
  };
  yourTurnVerified: boolean;
};
```

### 6.5 Learner model

| Situation                                  | Evidence                                                     |
| ------------------------------------------ | ------------------------------------------------------------ |
| The original problem after a full solution | `after_explanation` (no mastery gain)                        |
| Your Turn solved with no peek and no hint  | **`independent`**: counts toward mastery (this is the point) |
| Your Turn solved after a peek or a hint    | `with_hint`                                                  |
| Skipped                                    | Nothing logged; added to the review queue                    |

FSRS schedules the concept as usual.

**Setting:** "After a full solution: give me a Your Turn" (default **on**).

---

## 7. Live annotations while you write (auto-saved)

The student writes and the tutor **marks the page lightly as they go**, in its violet ink, like a teacher walking past the desk. Nothing needs saving by hand. Every mark is stored the moment it appears.

### 7.1 What the student sees

| Mark                                                 | When                                     | Example                                    |
| ---------------------------------------------------- | ---------------------------------------- | ------------------------------------------ |
| **✓ small tick** at the end of a line                | The checker verified the step is correct | `3x = 12` ✓                                |
| **Circle + a 1–4 word note** on the exact wrong part | The checker found an error               | circles `+7` → "sign?"                     |
| **Small arrow or underline + note**                  | Something is missing                     | "units?", "skipped a step", "not balanced" |
| **Margin note** (writing subjects)                   | The rubric check flags something         | "evidence?", "define this term"            |
| **Dashed "?"**                                       | neb isn't sure what it read              | tap → _"I read: 3x + 1 = 19 — right?"_     |

- **Hints, never the fix.** A mark points at _where_ and _what kind_ of problem. It never writes the corrected line. Show-then-You (section 6) only runs when the student asks for the answer.
- **Silent by default.** Marks appear without voice. The tutor speaks only if the student asks ("why?") or the level is Coach and they've been stuck.
- **Levels** (a quick toggle in the toolbar, saved per notebook):

  | Level                | Shows                                                                     |
  | -------------------- | ------------------------------------------------------------------------- |
  | Off                  | Nothing                                                                   |
  | Quiet                | Errors only                                                               |
  | **Normal** (default) | Errors + ticks                                                            |
  | Coach                | Also short margin hints, and a gentle "next step?" after about 20 s stuck |

- **Hide marks until I'm done** (for self-testing): marks are worked out but only revealed on **Alt + C** or "check".
- **Marks resolve themselves.** When the student fixes a marked line, the circle fades and a ✓ appears. Rewriting the same mistake doesn't add a second mark.
- **Tap a mark:**
  - **Why?** opens a short caption or voice explanation about that line (Mew `answer_question`, with the line as context).
  - **Not wrong** removes the mark and logs it as a correction. It feeds the eval sets for the checker and recognition (section 8).
  - **Hide** removes the mark.

### 7.2 When it marks (timing)

- **Never mid-stroke or mid-word.** A line counts as finished when any of these happen:
  - the pen pauses ≥ 1.2 s after the last stroke on that line
  - the pen starts a new line
  - the student moves to the next problem
- **What gets checked:** each finished line, against the previous line and the problem, through the checker router (SymPy, chemistry balance, Pyodide, rubric).
- **One mark burst per finished line.** At most about 6 unresolved marks are visible at once. If the student is writing fast, queue the marks and show them at the next pause.
- **Getting out of the way:** if the student starts writing while a mark is animating, finish the mark within 150 ms. Never draw over the pen.
- **Mew:** a new `live_annotate` path on line completion. It's rule-based and fast, with no gate model call in the normal case. Explicit questions always take priority.
- **Low recognition confidence (< 0.75):** **never an error mark.** Show the dashed "?" instead (section 8.2). A false red circle on correct work is the worst thing this feature can do.

### 7.3 Auto-saved

- **Real strokes.** Every mark is a tutor `Stroke` (`author: "tutor"`, `groupId` per line check, plus a `markKind`).
  - It's written to Dexie **in the same transaction** as that line's recognition result, then synced like student strokes. There's no save button.
- **Annotations layer:** marks live on their own layer, which can be shown or hidden per page (eye icon) and is included in exports.
- **New `annotations` table (RLS):**
  ```
  id, page_id, line_id, mark_kind, verdict, checker_method,
  recognized_text, confidence, stroke_group_id,
  created_at, resolved_at, dismissed_as ('not_wrong' | 'hidden' | null)
  ```
- **Undo:** tutor marks are **not** in the student's Ctrl + Z stack, so undo never skips over the student's own writing. Marks are removed by tapping them.
- **Everywhere else:** marks feed page Replay ("watch how this page was solved"), Notes Check, and Moments context.

### 7.4 Learner evidence

| What happened on a line                                | Evidence                            |
| ------------------------------------------------------ | ----------------------------------- |
| Correct first time, no mark                            | `independent` for that step's skill |
| Marked wrong, then fixed by the student without asking | `with_hint`                         |
| Fixed after tapping **Why?**                           | `after_explanation`                 |

Only **checker-verified** results count. A tick from model judgement alone (rubric subjects) is shown, but it's logged as `rubric`, not as mastery.

### 7.5 Speed and cost

- **Target:** line finished → mark visible in **≤ 1.2 s** for math and science, and **≤ 2.5 s** for rubric subjects.
- **Cost:**
  - recognition once per finished line, cached by stroke hash
  - checkers run locally or on our API
  - model calls only for recognition, rubric subjects and **Why?**
- **Budget:** a per-user daily budget is enforced server-side. When it runs out, drop to Quiet with a notice.

---

## 8. Handwriting recognition: measure, personalize, then train

We can't retrain Gemini on the fly. Reading gets better in four steps, in this order. **Don't skip the measuring.**

### 8.1 Measure first: an eval set

- **Location:** `evals/handwriting/`, with **at least 1,500 line samples** covering:
  - math: algebra, fractions, exponents, calculus
  - physics: units, vectors
  - chemistry: formulas, subscripts, arrows
  - code
  - prose
- **Variety:** different writers and devices (pen tablet, iPad, mouse, trackpad), neat and messy.
- **Sources:**
  - **Our team and opt-in beta users.**
  - **Public datasets** (IAM, CROHME, MathWriting) only if their licences allow it. Several forbid commercial use, so check each one, record the licence, and use them for **evaluation only** unless the licence clearly allows training.
- **Metrics:**
  - character and word error rate
  - math: exact LaTeX match, and **SymPy-equivalence match** (the one that matters)
  - chemistry: formula match
  - a per-symbol **confusion table** (x/×, 1/l/|, 5/S, 2/z, 0/O, t/+, −/–)
- **CI:** the eval runs on every recognition prompt or model change, with results reported per category. Get a baseline first, then set targets with the owner. Starting targets:
  - math equivalence ≥ 95% neat and ≥ 88% messy
  - prose character error rate ≤ 4%

### 8.2 Read better without training

- **Clean input:** render the line **from its stroke vectors** (not a screenshot) at 3× on white, padded, with even stroke width, and deskewed. Test in the eval whether also sending stroke order as compact text helps; keep it only if it does.
- **Context in the prompt:**
  - the previous 2 recognized lines and the problem statement
  - the subject
  - the chapter's vocabulary: variable names, units, chemical species and terms from course chunks
- **Several readings:** ask for the **top 3 readings with confidence**.
- **Choose with logic, not just the model's first pick:**
  - **Math:** prefer the reading that is a valid one-step move from the previous line (checked with SymPy).
  - **Chemistry:** prefer valid formulas.
  - **Code:** prefer what parses.
  - Fall back to the model's top pick only when none of these fits.
- **Confidence gate:** below 0.75 means no error marks; show a dashed "?" (7.1).
- **Show what neb read:** tapping a line shows _"neb read: 3x + 7 = 19"_ in small grey text, which the student can fix by typing or rewriting.

### 8.3 Learn each student's handwriting

- **Optional 60-second calibration** (in onboarding and Settings → Handwriting): the student writes digits 0–9; x y z t n; + − × ÷ = ( ) √ ∫ π θ Δ; and one sentence. These become their reference samples.
- **Every correction teaches.** "Not wrong", fixing what neb read, and the "?" confirmations each save a pair (stroke crop + correct text) to the student's **handwriting profile**.
- **Use the profile on every recognition call:**
  - include **3–6 of the student's own corrected examples** most similar to the current line (nearest by visual embedding, or by their known confusions) as few-shot examples
  - add a short confusion note, e.g. "this student's 7 has a crossbar; their z looks like a 2"
- **Visible and deletable:** Settings → Handwriting shows _"neb has learned 42 things about your handwriting"_, with **Reset**. Stored per user with RLS.
- **Prove it works:** measure accuracy before and after personalization on a held-out set of each user's corrections, and show the results in the eval report.

### 8.4 Train our own model (later, consent only)

- **A separate opt-in:** _"Help improve how neb reads handwriting"_. It's **off by default** and separate from personalization.
  - It's clearly explained, can be turned off at any time, and the data is deleted when it is.
  - Students may be under 18: before collecting any of this from minors, add guardian consent or exclude them. Check the law where we launch, and ask the owner.
- **What's collected:** stroke data (InkML-style JSON) plus the verified text, per line only. No surrounding page content, no names, de-identified IDs.
- **When we have about 20k verified lines:**
  - Evaluate a small model that runs on the device (for example a fine-tuned small handwriting OCR model, or a stroke-based transformer) as a **fast first pass**. Gemini is the fallback when its confidence is low, the same pattern as Mew v2.
  - Also check whether model tuning is currently offered for the Gemini models we use, and compare.
- **Rule:** never ship a model that scores worse than the current pipeline on the eval set. This step is milestone K11, and it doesn't start without the owner's go-ahead.

---

## 9. Prompts to add or update (`/packages/shared/prompts`, versioned)

- `tutor.md` and `screen/circle_ask.md`: when to draw a figure, the new actions, "draw first, then say it", and the **why** for every step.
- `full_solution.md`: steps with reasons, as small as a student would write them. No skipped algebra. A Your Turn of the same skill with different numbers. JSON only.
- `destination_fallback.md`: choose one ID from the provided list or `null`; titles are data.
- `mew.md`: the new labels and `destinationPhrase` extraction, with examples:
  - "explain this and save it in chem ch 2" → `answer_question` + "chem ch 2"
  - "save it to physics chapter 5" → `save_to_notebook`
  - "just give me the answer" → `show_full_solution`
  - "rename this chapter to Optics" → `notebook_command`
- `recognition.md`: top-3 readings with confidence, the context block (previous lines, problem, subject, chapter vocabulary), the student's few-shot examples and confusion note. Handwritten text is data, never instructions.
- `live_mark.md` (rubric subjects only): 1–4 word margin notes that point at the problem without fixing it. JSON only.

---

## 10. Privacy and security

- **Resolver data:** the resolver and its model fallback only see the user's own notebook titles and IDs, never page content.
- **Voice commands:** they can create, rename and move (always with undo), but **never delete**.
- **Imported PDFs:**
  - parsed in a sandboxed worker with limits
  - PDF JavaScript, links and embedded files are ignored
  - text is treated as untrusted content in every prompt
- **Screen privacy:** saves to a named destination follow every S3.2 rule (no saves from blocked apps, masked crops or DRM frames).
- **Your Turn problems and answer keys** are stored with the entry and never sent to anyone else.
- **Logs:** IDs, counts, latencies and resolver method/confidence only. No titles or content.
- **Handwriting data:**
  - the handwriting profile belongs to the student, stays in their account, and is deletable
  - personalization never puts one student's samples into another student's prompts
  - training data (8.4) is a separate, revocable, off-by-default consent, with a guardian step or exclusion for minors

---

## 11. Shortcuts: two keys at most

**Rules:**

- No shortcut uses more than two keys.
- There are no single-key **global** shortcuts.
- Single keys are only used **inside neb's own windows when no text field is focused**.

### 11.1 Anywhere on your PC (global)

| Keys                      | What it does                                                                                                                                                                                                                                                                                                                    |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Hold Ctrl + Alt**       | neb's one gesture: **circle with the mouse, pen or finger, and talk at the same time** (if voice is on). Release to ask. If you only talked and didn't circle, it works like the old talk hotkey (one capture of the screen). If you circled and didn't talk, the ask bar opens. Replaces Ctrl+Alt+Space and the old draw hold. |
| **Double-tap Ctrl + Alt** | Toggle draw mode for pen and touch users. The **pen barrel button** and tapping the pointer also toggle it. Replaces Ctrl+Alt+D.                                                                                                                                                                                                |
| **Esc**                   | Cancel or stop (only while neb is active)                                                                                                                                                                                                                                                                                       |

**Implementation notes:**

- **AltGr guard:** on many European keyboards AltGr sends Ctrl+Alt. Activate only after **300 ms** of holding with **no other key pressed**. If any other key is pressed, cancel silently. The mic opens only after the guard passes, and the pointer shows "listening".
- **Detecting the hold:** detect modifier-only holds by polling key state (as C1 does now), not with a keyboard hook that sees other keystrokes. Record this in Decisions.
- **Removed global hotkeys:**
  - Clip (old Ctrl+Alt+C) → circle, then **Ctrl + S** in the ask bar, or say "save this to …"
  - Notes Check (old Ctrl+Alt+N) → say "check my notes" while holding Ctrl+Alt, or use the notebook button
  - Pause → tray menu, or say "neb, pause"

### 11.2 Ask bar and caption card

| Keys         | Action                                                         |
| ------------ | -------------------------------------------------------------- |
| **Enter**    | Ask (or "explain this" if empty)                               |
| **Ctrl + S** | Save only, no explanation                                      |
| **Ctrl + D** | Change destination                                             |
| **→ / ←**    | Next step / repeat step (when not typing in the follow-up box) |
| **Space**    | Pause / resume (when not typing)                               |
| **Esc**      | Stop / close                                                   |

The silent-mode keyboard controls from S3.2 move to these keys. Keyboard drawing stays the same: Tab, Space, Shift + arrows.

### 11.3 In the notebook app

| Keys                    | Action                                                                     |
| ----------------------- | -------------------------------------------------------------------------- |
| **Alt + B**             | New notebook (name field opens). Works in the browser and the desktop app. |
| **Ctrl + N**            | New notebook (desktop app only; browsers reserve Ctrl + N)                 |
| **Alt + N**             | New chapter in this notebook                                               |
| **Alt + P**             | New page here                                                              |
| **F2**                  | Rename the selected notebook, chapter or page                              |
| **Ctrl + K**            | Jump to any notebook, chapter or page                                      |
| **Ctrl + O**            | Import PDF                                                                 |
| **Alt + C**             | Check my work / check Your Turn                                            |
| **Alt + ↑ / ↓**         | Move the selected chapter up or down                                       |
| **Ctrl + Z / Ctrl + Y** | Undo / redo                                                                |
| **P · E · H · L**       | Pen, eraser, highlighter, lasso (when not typing)                          |
| **Hold Ctrl + Alt**     | Circle on the page and talk (same gesture as everywhere else)              |

### 11.4 Rebinding

- **Settings → Shortcuts:** a key recorder that **rejects combinations over two keys** ("neb shortcuts are two keys max").
- **Conflicts:** detect them (`RegisterHotKey` failures, plus a list of known clashes: Ctrl+Space for IMEs, Alt+Shift for layout switching) and suggest alternatives.
- **Reset to defaults.**
- **Migration:** existing users with old three-key bindings are moved to the new defaults once, with a one-time "Shortcuts got simpler" card that lists the changes.
- **Docs:** update every old shortcut in onboarding, tooltips, the tray menu and docs. Search the codebase for `Ctrl+Alt+` strings and old binding IDs.

---

## 12. Tests

- **Tree:**
  - create with name; chapters by list, by count and from a PDF outline
  - rename, move, reorder
  - local-first sync: an offline name clash becomes "Physics 2" with a notice; a server-rejected move reverts with a notice; the latest title edit wins across two devices
  - depth limit, cycle prevention, sibling uniqueness
  - soft delete and restore
  - RLS (another user can't read or attach to your nodes)
  - offline reorder merge
- **Resolver fixtures (≥ 60 phrases):**
  - "physics chapter 5", "chapter five of physics", "phys ch5", "the kinematics chapter", "unit 3 in chem", "my bio notebook"
  - ambiguous cases → chips; missing chapter → create offer
  - model fallback returns only valid IDs
- **Save timing:** destination said with the question, during the explanation (no interruption), after (moves, no duplicate), and without a question (clip only); sticky destination per source.
- **PDF import:**
  - outline split, page ranges, the 10-page fast path, encrypted-file message
  - a notebook with no course gets one created and linked; "Review topics" appears without blocking the import
  - the offline cache stays under its limit; "Make available offline" downloads all pages; strokes on uncached pages still save offline
  - "From screen" gets date headings and rolls over to "From screen 2"
  - a scanned PDF without a text layer
  - a malicious PDF (JavaScript, huge page count, malformed) handled safely
  - injection text inside a PDF gets a normal explanation
- **Geometry solver:** right, obtuse and impossible triangles; the right-angle marker sits at the correct vertex.
- **Molecules:** benzene, cyclohexane, ethanol; invalid SMILES falls back to words.
- **Show-then-You:**
  - SymPy step verification catches a wrong step
  - unverifiable solutions are not presented as certain
  - Your Turn answer key verified
  - folding and peeking; peek → `with_hint`
  - solved alone → `independent`
- **Shortcuts:**
  - no default or user binding over two keys
  - in Chrome and Edge, Alt + B, Alt + N, Alt + P, Alt + C, Alt + ↑/↓, F2, Ctrl + K, Ctrl + O and Ctrl + D reach neb; Alt + ←/→ stay with the browser
  - AltGr typing (@, €, {) never triggers neb
  - Ctrl + Alt hold with talk only / circle only / both
  - migration card shown once
- **Auto-filing and moments:**
  - a physics video moment lands in Physics › the matching chapter, not the open Chemistry notebook
  - same-source memory after a Change
  - subject-only match → notebook level with chapter chips
  - no match → Unsorted with a "+ New notebook" chip
  - no notebook is ever created without a tap
  - the YouTube link opens at the right second
  - a text fragment scrolls to the circled text
  - Replay uses the stored audio
  - a check question with a wrong answer key is never stored
  - same-concept moments merge
  - the 15-per-day cap holds
  - a check answered correctly without peeking logs `independent`
- **Live annotations:**
  - a tick only after checker verification
  - a wrong line gets a circle and a hint, never the corrected line
  - no mark while the pen is mid-line
  - a low-confidence reading gives a "?" and never an error mark
  - a fixed line resolves its mark; the same mistake twice doesn't add a second mark
  - Hide-until-done reveals marks on Alt + C
  - marks survive a reload and offline sync, and aren't in the student's undo stack
  - "Not wrong" logs a correction
  - evidence: first-try correct → `independent`, fixed after a mark → `with_hint`
  - when the budget runs out, the level drops to Quiet
- **Handwriting:**
  - the eval runs in CI with per-category results and a confusion table
  - top-3 readings plus SymPy choice fix the "1 vs 7" and "x vs ×" cases in fixtures
  - personalization improves held-out accuracy for a test user with known quirks
  - the profile Reset clears everything
  - no one else's samples ever appear in a prompt (test with two users)
  - the training opt-in is off by default and deleting it removes the data

## 13. Non-goals

- Unlimited nesting (3 levels max)
- Sharing notebooks or collaborating on them
- Deleting anything by voice
- Exporting notebooks to PDF (later)
- Single-key global shortcuts

---

## 14. Milestones

**K1 — Notebook tree.** Migrations and triggers, RLS, create-with-name popover, chapters by list/count, home view, sidebar tree, rename (F2/double-click), Alt+N, Alt+P, move/reorder, Trash, breadcrumb, Ctrl+K, Dexie sync, chapter-scoped context.
_Accept:_ I press Ctrl+N in the desktop app (or Alt+B in the browser), type "Physics", set 4 chapters, rename Chapter 2 to "Forces" before creating, and press Enter. Physics opens with 4 chapter cards. After a reload everything is still there, offline too.

**K2 — Two-key shortcuts.** New bindings, the unified Ctrl+Alt hold (circle + talk), AltGr guard, double-tap toggle, ask bar and caption keys, rebinding rules, conflict detection, migration card, docs and Decisions.
_Accept:_

- Holding Ctrl+Alt while circling a paragraph and asking a question out loud gets an answer.
- Typing "@" with AltGr on a German layout never activates neb.
- The shortcut recorder refuses Ctrl+Shift+Alt+X.

**K3 — Save where I say.** Resolver package and fixtures, Mew labels and `destinationPhrase`, destination chip, picker (Ctrl+D), toast with Change, move-not-duplicate, sticky destination, create-on-confirm.
_Accept:_

- I circle a right-triangle question on a YouTube video and say "why is this the hypotenuse? save it to my physics notebook chapter 5". The entry lands in _Physics › Chapter 5 › From screen_ with the YouTube timestamp.
- If Physics has only 4 chapters, I'm offered "Create Chapter 5 and save".

**K4 — PDFs into chapters.** Import dialog, destination, page ranges, outline split, rendering and text layer, lazy pages, course ingestion scoped to the chapter, Circle & Ask on PDF pages inside neb using the text layer.
_Accept:_ I drop a 120-page textbook PDF on _Chemistry_ and choose "Split into chapters". I get one chapter per outline entry with the right pages, can write on any page, and asking about a circled paragraph cites that page. Because _Chemistry_ had no course, one is created and linked, and "Review topics" shows up later. Pages I viewed still open offline.

**K5 — Explaining by drawing.** `draw_geometry` with solver, `draw_molecule` with SMILES layout, sketch card on screen, the same actions in the notebook, prompt updates, validation.
_Accept:_

- "Explain the carbon rings" on a circled benzene diagram in a PDF draws a ring with its six carbons in the sketch card, step by step, before the words.
- "Why is this a right angle?" draws a triangle with the right-angle square at the right vertex.

**K6 — Show-then-You in the notebook.** Pointer in the canvas, annotating the student's own lines, full-solution schema with SymPy/checker verification, steps with reasons, fold and peek, verified Your Turn variant, the checking loop (Alt+C or pen pause), evidence logging.
_Accept:_

- I write `3x + 7 = 19` and say "just give me the answer". The pointer writes each step with its reason, boxes x = 4, folds the solution and writes "Your turn: 5x − 4 = 21".
- A wrong second line gets circled with a hint. When I finish correctly without peeking, it's logged as `independent`.

**K7 — Show-then-You on screen, and polish.** Direct-answer flow in Circle & Ask, saving with the folded solution and a Your Turn box to the destination, accessibility (Narrator announcements for destinations and Your Turn, keyboard-only flow), full e2e test pass, Decisions updated.
_Accept:_ On a circled homework question in Edge, I say "just tell me the answer and save it to Physics chapter 5". I see the steps annotated on screen, and _Physics › Chapter 5_ has the entry with the solution folded and a Your Turn waiting. I complete it there with the keyboard and pen only.

**K8 — Auto-filing, Moments and quizzes.** `subject`/`conceptHints`/`checkQuestion` in the answer schema, notebook `subject` column, filing signals and precedence, Unsorted notebook with batch tidy, Change-teaches memory, Open source deep links (YouTube time, PDF page, text fragments), stored TTS for Replay, Moments tab, check-question verification, FSRS cards with merge and daily cap, Quick check, chapter badges, evidence logging, "Quiz me on what I saved" voice command, setting.
_Accept:_

- I'm watching a YouTube lecture on projectile motion with my _Chemistry_ notebook open. I circle a graph and ask "why is this curved?" without saying where to save. The moment lands in _Physics › Chapter 3 · Kinematics_, and the toast says "matched projectile motion".
- **Open source** returns to the video at that exact second, and **Replay** plays the explanation with the same voice.
- The next day, Quick check asks me a question about it. Answering correctly without peeking logs `independent`.
- A moment from a biology video, when I have no Biology notebook, lands in Unsorted with a "+ New notebook: Biology" chip.

**K9 — Live annotations.** Line-completion detection, the `live_annotate` path, checker per line, mark kinds and placement, levels and toolbar toggle, Hide-until-done, self-resolving marks, tap menu (Why? / Not wrong / Hide), the annotations layer and table, saving in the same transaction as recognition, evidence logging, budget fallback.
_Accept:_

- I write `3x + 7 = 19`, then `3x = 26`. Within about 1 second, `+ 7` / `26` is circled with "sign?". I fix it to `3x = 12` and the circle turns into a ✓, with no voice unless I ask.
- I reload the page offline and every mark is still there.
- A line neb couldn't read gets a "?" instead of a red circle.

**K10 — Handwriting: measure, read better, personalize.** The `evals/handwriting` set with a licence record, CI report, stroke-based rendering, context block, top-3 readings with logic-based choice, confidence gate, the "neb read:" correction UI, calibration, the handwriting profile with few-shot examples and confusion notes, Settings → Handwriting with Reset, a before/after report.
_Accept:_

- The eval baseline is reported per category.
- After the context and top-3 changes, math equivalence improves on the messy set.
- A test user whose 7s look like 1s gets them read correctly after 5 corrections, shown on their held-out samples.

**K11 — Our own handwriting model (later, only with the owner's go-ahead).** Consent flow (including minors), de-identified collection, training and evaluating an on-device first-pass model with Gemini as the fallback. It ships only if it beats the current pipeline on the eval set.

---

## Decisions

Binding for the K series. 1–13 are the owner's answers in 0.1 (not repeated here); the rest were
settled while building and are recorded so later milestones don't reopen them.

14. **The tree syncs on its own path, always on (K1).** Nodes (titles, order, labels, icon,
    colour, course link, trash state) go to the server through `sync_notebook_tree`, separate from
    Notes Check's line sync, and regardless of the `notes_index` setting: saving by voice (K3) and
    auto-filing (K8) need the titles on the server, and titles are not note content. Page
    _content_ (strokes) still stays on the device. The student's own Clerk session writes them,
    so RLS and the triggers apply.
15. **Node edits carry `editedAt`, separate from `updatedAt` (K1).** `updatedAt` stays "last
    used" (the sidebar's recency); `editedAt` is when the title, place or settings last changed,
    and decides latest-edit-wins. A node edited on another device arrives on the next sync; its
    pages don't (strokes are per device), so it shows with no pages there.
16. **Opening a node (K1).** A node with children opens on its home view (cards for its children,
    its own pages as "Loose pages"); a node without children opens its first page directly, as
    a notebook did before. New chapters get one empty page each, so they open straight away.
17. **Line sync waits for the tree (K1).** Notes Check's `sync_note_page` no longer writes a
    notebook's title or course (the tree sync owns them); a page's lines are synced only after
    its node reached the server, so a page can never create its notebook in the wrong place.
18. **Chapters "from a PDF or syllabus" come with K4.** They need the PDF outline reader built
    there; K1 ships chapters by list and by count.
19. **Trash is purged on the device after 30 days**, and the purge is sent to the server like any
    other change (the rows are deleted there; their pages and lines go with them by cascade).
20. **Notes Check scopes follow the tree (K1, "chapter-scoped context").** A notebook scope is
    the node and everything under it; a course scope is every notebook linked to the course, with
    its chapters and sections (only a notebook carries the link). A check from a page sends its
    node; the server searches the widest scope (node, then its notebook, then the course) and
    ranks the open chapter's lines first (×1.5), then its notebook's (×1.2). Searching only the
    nearest scope would hide related notes in sibling notebooks of the same course.
21. **A device with no notebooks takes the account's** (pulls the tree) before making a first
    notebook, so a new browser or second computer never adds its own "My first notebook".
    Notebooks arriving from elsewhere take their last edit as their "last used" time.
22. **Opening a node makes it the most recently used**, so the app reopens what was open (a
    notebook and its chapters made together would otherwise tie).
23. **The breadcrumb sits under the toolbar**, top left (the toolbar takes the top centre), and
    hides while a quiz card is there.
24. **Course progress on chapter cards comes with K4**, when chapters become course sections;
    K1's home shows the notebook's course link.
25. **A full page reload with no network needs a service worker**, which the app doesn't have
    yet (true before K1). The tree itself is on the device: it opens with the server
    unreachable, edits work offline and sync when the connection is back.
