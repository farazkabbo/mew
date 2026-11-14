# Neb: feature inventory

Every feature in the app, grouped by where the student meets it. This is the checklist for the
polish pass: each area ends with the rough edges already known. Build details, decisions and
file paths are in [HANDOFF.md](HANDOFF.md); how to run things is in [USAGE.md](USAGE.md).

Neb has three parts:

- **The web app** (Next.js): the desk, notebooks, courses, review and settings.
- **The desktop app** (Windows, Tauri): the web app in its own window, plus **Screen Coach**, a
  tutor that works over any Windows app.
- **The backend** (FastAPI and Supabase): storage, search, filing and the learner model.

The app's code name is Mew. It still shows in internal names (`mew-desktop.exe`, `mew:*` events,
the `mew_api` package) but must never show to a student.

---

## 1. Account and getting started

### 1.1 Sign-up and sign-in

- Clerk sign-up and sign-in pages (`/sign-up`, `/sign-in`).
- Sign-out from the desk menu.
- Deleting the account also revokes the desktop's device tokens.

### 1.2 Onboarding

- An introduction in steps, with "Try it" moments.
- It can be replayed from Settings → Introduction.

### 1.3 Linking the desktop app

- The desktop app signs in through the browser (PKCE). Its token is kept in Windows Credential
  Manager.
- The flow uses `/desktop/link`, `/desktop/authorize` and `/desktop/finish`.
- Settings → Signed-in devices lists linked computers and can sign one out.

### 1.4 Status page

- `/status` runs end-to-end checks of the sign-in chain for the signed-in account.

**Rough edges**

- The Clerk application name still says "Mew" (on Clerk's own screens). It's changed in the Clerk
  dashboard, not in the code.
- Changing the password doesn't revoke device tokens yet. That needs a Clerk webhook.

---

## 2. The desk (`/desk`)

The home page. The desktop app opens on it.

- **Notebook covers**, with ribbons for things that "stayed" this week.
- **Tonight card**: what's due and what to do next.
- **Moment cards**: recent things saved from the screen.
- **Desk menu**: settings, the account and sign-out.
- Light and night appearance, and text size (§8.2).

---

## 3. Notebooks (`/notebook`)

### 3.1 Notebook tree

- Notebooks → chapters → pages, three levels deep.
  - New notebooks get an icon and colour suggested from the name.
  - A notebook can be linked to a course and divided into chapters, by list or by number.
- **Sidebar tree**:
  - Keyboard: arrows, Enter, F2 to rename, Alt+↑/↓ to reorder.
  - Drag above, below or into another item.
  - A menu on each row.
- **Each node's home page**: chapter cards (with course progress), loose pages, and add a chapter.
- **Moving and deleting**:
  - The breadcrumb opens any node's home.
  - "Move to…" uses a picker.
  - Delete asks for confirmation and offers Undo.
  - The trash keeps items for 30 days.
- **Ctrl+K jump palette**: finds notebooks, pages and moments, and runs "> " commands.
- **Sync**:
  - Local-first: Dexie on the device, with an outbox.
  - Syncs with the server's tree; the latest edit wins.
  - Clashing names get a suffix, e.g. "Physics 2".

### 3.2 The page and the pen

- **Writing**:
  - A handwriting canvas with pen, eraser and lasso.
  - Undo and redo (Ctrl+Y).
  - Live sync between tabs.
- **Layout**: page header, pencil case (the tools), neb's lane, tabs, the Contents drawer, the ask
  pill and the replay bar.
- **Page Replay**: plays the page back stroke by stroke.
- **Holding Ctrl+Alt on the page**:
  - Talks to neb.
  - Circles lines, which become the context for the next question.

### 3.3 Handwriting recognition

- Every finished line is read, with a confidence score.
- "neb read: … · Fix" appears on any line selected with the lasso.
- **Personalisation** (Settings → Handwriting):
  - A calibration with your own pen.
  - Corrections are learned.
  - Course topics are used as vocabulary.
  - Reset clears it, and learning can be turned off.

### 3.4 The tutor in the notebook

- Explains, hints and checks written working step by step.
  - Maths is checked by SymPy.
  - Chemical equations are checked for balance.
  - Code runs in Pyodide.
- **Ink**:
  - Draws on the page in its own hand (Hershey glyphs and a LaTeX subset), animated and undoable.
  - The ink can be hidden.
- **Visuals**:
  - Plots, mind maps and flowcharts.
  - Sketches, such as force diagrams.
  - Geometry, solved before drawing (e.g. triangles).
  - Molecules, drawn from SMILES.
- **Pointer**: a pointer glides to what neb is talking about.

### 3.5 Live annotations

- Marks appear on each finished line as you write:
  - a tick when it's right;
  - a loop round the wrong part, with a short note;
  - a missing step;
  - a margin note with an arrow;
  - a dashed "?".
- Levels per notebook: Coach, Quiet, and "hide until done". Choose them in the marks menu on the
  toolbar.
- Tapping a mark opens "Why?". Alt+C reveals hidden marks. Resolved marks fade.
- Marks feed the learner model as evidence.

### 3.6 Show-then-You

- "Just tell me the answer" gives a verified solution:
  - steps with reasons and a boxed answer;
  - fold and peek.
- **Your Turn** follows with a similar problem:
  - each line is checked;
  - a hint step, Skip, and "One more".
- Code problems get a Your Turn too; the reference program is run before it's shown.
- The offer appears by itself after two wrong tries.
- Setting: "After a full solution: give me a Your Turn" (on by default).

### 3.7 PDFs

- **Import**:
  - Import with Ctrl+O, "Import PDF", or by dropping a file on the sidebar or a page.
  - "Chapters from a PDF…" splits the pages into chapters.
- **Reading**:
  - Write on PDF pages.
  - Circle printed text and ask about it.
  - "Recognize text" reads scanned pages.
- **Offline and review**: "Make available offline" keeps the pages on the device, and "Review
  topics" shows what's in them.
- **Open in neb**: opens a saved moment's PDF page with the circled words highlighted.

### 3.8 Moments ("From screen")

- Things saved from the screen land on a "From screen" page, under date headings. A new page
  starts after 30 entries.
- Each entry has:
  - the picture;
  - the explanation as a note under it;
  - Replay, step by step in the same voice;
  - an "Open source" link (with the video's timestamp);
  - "Check against my notes".
- The **Moments tab** on each node's home lists, filters and moves moments.
- **Unsorted**:
  - moments neb couldn't file;
  - "File these" suggests a place for each.

**Rough edges**

- A PDF import listed only its first page until this branch's fix. Large imports are worth
  re-testing with a real 120-page textbook.
- The K4, K6 and K9 checks by hand are still open: pen and finger on marks, 150 % zoom, and an
  offline reload of the PWA.

---

## 4. Talking to neb (voice)

- **Speech to text**:
  - ElevenLabs Scribe, realtime.
  - The audio goes straight from the page with a single-use token.
- **Text to speech**:
  - ElevenLabs.
  - Choose a voice in Settings → Voice; each voice has a sample.
- **Languages**:
  - English, French, Bengali and Mandarin Chinese (Simplified).
  - The setting covers speech, the tutor's answers and the screen cards.
- **What neb understands from speech**:
  - questions;
  - "save this to …";
  - notebook commands;
  - "show me the full solution";
  - "what can I say?".

**Rough edges**

- Speaking right after clicking the mic loses the first word. Waiting about a second works.
- Running out of quota reports "refused the server's key". The message should say the quota ran
  out.
- Only one voice shows until `ELEVENLABS_VOICES` lists more.

---

## 5. Screen Coach (desktop, Windows)

A tutor over any Windows app. It's turned on, with consent, from the desktop app's settings page.

### 5.1 The island

- A black notch at the top centre of the screen. Double-tap Ctrl+Alt to show or hide it.
- **Status**: Listening, Looking, Thinking or Speaking.
- **Tools**:
  - Pen and Eraser.
  - Select, with a menu: freehand, rectangle or ellipse.
  - Mic: click, speak, then click again.
  - Clear and Close.
- **Pen notes**: drawn on the screen only, never sent. They follow the page as it scrolls.
- **Music (♫)**:
  - Shows what's playing on the PC, with album art and the play, next and previous buttons.
  - Up to six pinned Spotify playlists or albums. Nothing signs in to Spotify.
- **Pens**:
  - Windows Ink pens can press the island's buttons.
  - The on-screen pointer follows a hovering pen.

### 5.2 Asking about the screen

- **What it does**:
  - Speaks an answer, and draws violet ink beside the text on screen: circles, underlines,
    highlights, arrows, margin notes and written steps.
  - When the student's course covers the topic, the answer names the course and the page.
- **When the screen changes**:
  - The ink fades when the content moves.
  - "Show that again" puts it back.

### 5.3 Circle & Ask

- **Asking**:
  - Circle, or box, part of the screen, then ask by voice or by typing in the card's ask box.
  - "Select question on screen" reads a handwritten question.
- **The card**:
  - The explanation plays step by step, with captions and Pause · Repeat · Next · Stop.
  - Ink appears before the words.
  - Ink snaps to the words on screen.
- **Follow-ups**: asked by voice or with the card's mic.
- **Show-then-You**: "Just tell me the answer" works here too, followed by a Your Turn in the
  notebook.
- **Silent mode**: drawing and asking with the keyboard only.

### 5.4 Saving to the notebook

- **When it saves**:
  - Circle & Ask saves the entry automatically. The save toast shows the place, with Undo, Open
    and Change.
  - "Save this", or Ctrl+S on the card, saves a clip after a preview.
- **Where it goes**:
  - "Save this to Physics chapter 5" saves to a place you name. If the place doesn't exist yet,
    "Create it and save" offers to make it.
  - **Auto-filing**: with no place named, neb picks one from where earlier moments from that source
    went, the content and the subject. It says why, and offers chips and "+ New notebook". Moving a
    moment teaches it.
- **Getting it there**: failed saves are kept and offered again, and uploads retry.

### 5.5 Notes Check

- Say "check my notes" while a lecture or page is on screen.
- **What it does**:
  - Compares what's on screen with the student's notebook lines.
  - Marks what's missing or different, beside the text, and shows the results in a panel.
- **Following up on a finding**:
  - Answer it.
  - "My note is right".
  - "Tell me". It explains by itself after two misses.
  - Dismiss.
  - "Add it", which writes a heading, then offers "Check what I wrote".
- **What it uses**:
  - Only redacted text from the screen is sent.
  - Maths is checked by SymPy.
  - Outcomes become learner evidence.

### 5.6 Coach mode (walkthroughs)

- "Teach me how to make a pivot table" starts a plan of 3 to 15 steps, one step at a time.
- **During a walkthrough**:
  - An arrow points at each control.
  - "Done" moves on, and each step is verified.
  - "I'm stuck" gives a hint ladder.
  - A progress pill has the buttons.
  - Stop, then "continue where we left off" resumes it.
- **Afterwards**:
  - A finished walkthrough becomes a skill.
  - "Let me try … on my own" re-checks the skill solo; done with no hint, it counts as mastered.

### 5.7 Quiz me on this

- "Quiz me on this" puts one to three questions about the screen on a quiz card.
- **Answering**:
  - By voice, by typing, or by tapping a choice.
  - "Skip", "next" and "stop" work too.
- Cards come back in the review's Quick check.

### 5.8 Privacy and control

- **Capture**:
  - The screen is captured only when the student asks.
  - It's redacted on the PC first: cards, codes, emails, password fields, private windows and
    blocked apps.
  - It's never stored; only what the student saves is kept.
- **The coach frame**: a glowing frame shows whenever neb can see the screen.
- **Pausing**:
  - "Neb, pause", or "Pause for 1 hour" from the tray.
  - It pauses automatically during calls and screen recordings; this can be turned off.
- **Being seen**:
  - Neb's windows are hidden from screen shares by default.
  - "Show Neb in screen shares and recordings" makes them visible, e.g. for recording a demo.
- These settings change only from the desktop app's local settings page.

### 5.9 Tray, reminders and updates

- **Tray**: states, Pause and Resume, and opening Neb.
- **Reminders**: skills due and checks due, at most twice a day. They're opt-in.
- **Updates**: signed, downloaded in the background, and installed when the student says so.

**Rough edges**

- **Empty Notes Check panel**: the panel showed empty the first time. The fix on this branch is
  untested by hand.
- **Ink fading**: ink from a spoken answer sometimes fades straight away ("ink faded (Typed)"),
  with no pen in use. The cause is unknown.
- **Refusals**: why a capture was refused shows only as a Windows notification, not on the card.
- **Notes Check speed**: it can take 15 s or more, because retrieval is slow.
- **Saves after a follow-up**: a refused save after a follow-up was seen once. Retries now cover
  it, but the root cause is unconfirmed.
- **Docs**: [USAGE.md](USAGE.md) still describes the hold-to-talk gesture and Ctrl+Alt+N. The
  island and voice commands replaced them.
- **Hand checks still open**: listed per milestone in [HANDOFF.md](HANDOFF.md) §2. They cover
  150 % zoom and second monitors, Teams and OBS captures, and AltGr layouts.

---

## 6. Courses (`/courses`)

- **Setting up a course**:
  - Upload a course PDF.
  - It's split into concepts, each with a lesson, and becomes a concept graph.
- **Using a course**:
  - Concept pages: `/courses/[id]/concepts/[conceptId]`.
  - The tutor and Screen Coach cite the course ("page 12 of your notes").
  - Chapter cards in the notebook show course progress.
  - An exam plan, with exam dates prioritised.

---

## 7. Review (`/review`)

- **Due concepts**, with **Quiz me**.
- **Quick check**:
  - Saved moments and screen quizzes.
  - At most 15 new cards a day.
  - Answer by voice ("Say it"), in writing, or by choosing.
  - "I don't know yet" is an answer.
  - Merged cards list their moments.
- **Skills to re-check**: skills from coach mode.
- **Scheduling and evidence**:
  - Scheduled with FSRS.
  - Every answer is evidence for the learner model (statuses and attempts).

---

## 8. Settings (`/settings`)

### 8.1 The tutor and voice

- The tutor's preferences.
- Language.
- Voice (the picker, §4).
- Listening.

### 8.2 Appearance

- Light or night, and text size.

### 8.3 Shortcuts

- Every web shortcut can be re-recorded, and Reset restores them.
- **The two-key rule**: never on Ctrl+Alt.
- **Defaults**:
  - Alt+B for a new notebook (Ctrl+N in the desktop app), Alt+N, Alt+P.
  - F2, Ctrl+K, Ctrl+O, Alt+C.

### 8.4 Moments and checks

- "Quiz me on things I save".
- Check reminders.

### 8.5 Handwriting

- Calibration, learning on or off, and Reset.

### 8.6 Privacy and devices

- The note-search index (`notes_index`).
- Signed-in devices.
- "Help improve Neb", which is opt-in logging.

### 8.7 This computer (desktop only)

- Screen Coach's consent and settings, and pausing.

### 8.8 Introduction and performance

- Replay the introduction.
- A table of how long each step takes.

---

## 9. Teach neb (`/teach`)

- With "Help improve Neb" on, neb keeps its decisions (what it heard, what it chose to do).
- Each decision is shown on a card. The student can label it right or wrong, or delete them all.
- Labelled decisions become the dataset for training neb's own in-browser model (Mew v2).

---

## 10. Developer pages

- `/dev/ui`: the component and token gallery.
- `/dev/handwriting`: collects real handwriting samples for the eval.

---

## Polish pass: where to start

The rough edges above, in rough order of demo impact:

1. **The Notes Check panel**: verify the fix, then speed it up.
2. **Ink fading after spoken answers.**
3. **Voice**:
   - Lose the first-word clipping.
   - Make the quota error message honest.
4. **Show capture refusals on the card.**
5. **Wording**:
   - Bring [USAGE.md](USAGE.md) up to date with the island.
   - Rename the Clerk app to Neb.
6. **The hand checks still open** in [HANDOFF.md](HANDOFF.md) §2, area by area.
7. **The licences page** for bundled packages (smiles-drawer, roughjs, chroma-js).
8. **Releases**: the updater's signing key, and the hosted migrations still waiting (check
   HANDOFF §2 and §6 for which).
