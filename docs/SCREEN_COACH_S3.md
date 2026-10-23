# S3 — Annotate on Screen + Save to Notebook (Windows)

Replaces the previous S3 in [SCREEN_COACH.md](SCREEN_COACH.md). Read that brief and its
**Decisions** section first; everything there still applies (Rust owns capture and upload,
screenshots never enter page JS except an explicitly confirmed clip, blocked apps, redaction,
rule-based safety check, capture scope rules). Decision 9 there records how the open questions
below were settled; where it differs from this brief, the decision wins.

---

## 1. What the user experiences

### A. PDF question

1. The student has a PDF open (Edge, Acrobat, Chrome, any viewer) on "Question 3".
2. Holds **Ctrl + Alt + Space**: "Help me with question 3."
3. The tutor captures the screen, finds question 3, and **draws beside it** in violet ink:
   - circles or underlines the key words in the question
   - writes a short hint or the first step in the **free space next to the question** (margin),
     never on top of the text
   - says one or two short sentences out loud
4. The student says **"save this"** (or presses **Ctrl + Alt + C**, or clicks **Save to
   notebook**).
5. A small preview appears: the question crop **with the tutor's annotations on it**. The
   student can adjust the crop and press **Save** (Enter) or **Cancel** (Esc).
6. A new notebook page opens with the question image and the tutor's annotations as **real,
   editable ink strokes** on top. The student keeps working on it by hand.

### B. YouTube video

1. The student pauses a lecture on a diagram.
2. "What's going on in this diagram?"
3. The tutor annotates **beside the video player** (arrows into the frame, labels outside it so
   the diagram stays readable) and explains briefly.
4. "Save this" → preview of the video frame + annotations → Save.
5. The notebook page contains the frame, the annotations, and a source line: video title and a
   **link back to that timestamp** (e.g. `youtube.com/watch?v=…&t=754s`).

If the video is still playing, the tutor says "Pause it on the part you want" before capturing,
so the frame matches what they mean.

---

## 2. Overlay annotation

### 2.1 Actions

Boxes are `{left, top, right, bottom}` and points `{x, y}`, normalised 0–1000 across the
screenshot (Gemini's schema subset can't describe tuples).

```ts
type ScreenAction =
  | {
      type: "focus_region";
      box: Box;
      kind: "question" | "figure" | "video_frame" | "code" | "text";
    }
  | { type: "circle_region"; box: Box; label?: string }
  | { type: "underline"; box: Box }
  | { type: "highlight"; box: Box }
  | { type: "point_at"; point: Point; label?: string }
  | {
      type: "margin_note";
      text: string;
      besideBox: Box;
      side?: "left" | "right" | "below" | "auto";
    }
  | {
      type: "write_step";
      latexOrText: string;
      besideBox: Box;
      side?: "left" | "right" | "below" | "auto";
    }
  | { type: "clear" };
```

- Every response that annotates **must include one `focus_region`**. It anchors placement and
  becomes the default crop when saving.
- Keep text short: a margin note is a few words or one equation.

### 2.2 Placement "beside" content

1. Map boxes to screen coordinates (existing DPI/multi-monitor mapping).
2. Build an occupancy map from on-device OCR word boxes plus the `focus_region`.
3. `side: "auto"`: try right of the focus region, then left, then below; take the first area
   large enough at the current ink size that overlaps no text.
4. No free space: a **sticky-note card** (semi-opaque paper) at the nearest edge with a short
   arrow to the target.
5. Video: notes go **outside the player bounds** with arrows pointing in.
6. Ink size scales to the monitor DPI and the size of the surrounding text.

### 2.3 Keeping ink attached to content

- Watch the target window (`SetWinEventHook`: location, scrolling, foreground, minimise).
- On scroll, move, resize, minimise or app switch: **fade out** the ink within ~150 ms and keep
  the last annotation set in memory for 2 minutes.
- "Show that again" or the hotkey: re-capture and re-place the same annotations on the new
  layout.
- Esc clears ink at any time.

---

## 3. Save to notebook

### 3.1 Triggers

- Voice: "save this", "put this in my notebook", "clip this"
- Hotkey: **Ctrl + Alt + C**
- **Save to notebook** button
- With no annotation visible, Ctrl + Alt + C starts a **manual drag-select** clip instead.

### 3.2 Pipeline (all in Rust until the user confirms)

1. **Reuse the screenshot** from the annotation turn if the window hasn't changed since;
   otherwise capture again.
2. **Privacy filter** as in the main brief. Fail closed.
3. **Crop** to the `focus_region` expanded to include all annotation bounds plus 24 px padding;
   clamp to the captured window/monitor.
4. **Annotation strokes**: the overlay is excluded from capture, so the screenshot is clean.
   Take the ink as **vector strokes** and transform them into crop-relative coordinates. Do not
   burn them into the image.
5. **Preview window**: local-only, bundled assets, strict CSP, no network, filesystem or shell
   access; the image comes through a Rust custom protocol from memory (never a file); crop
   handles, "Include tutor notes" (on), "Include source link" (on for videos/web pages);
   Cancel or 60 s without a decision → discard everything.
6. **On Save**, Rust encodes the crop, uploads it with the device token, the server creates the
   clip, and the main app opens the new notebook page.

### 3.3 Source metadata

- `source_app` (exe name), `source_title` (window title, only for saved clips)
- Browsers: the address bar via UI Automation. YouTube: video URL + current timestamp (from the
  player, else read from the screenshot, else no timestamp). Other pages: page URL.
- The link is stored only if "Include source link" was on at save time.

### 3.4 Notebook representation

```ts
type ImageBlock = {
  id: string;
  pageId: string;
  type: "image";
  storagePath: string;
  width: number;
  height: number; // page units
  x: number;
  y: number;
  source?: { app: string; title?: string; url?: string; timestampSec?: number; capturedAt: string };
  ocrText?: string;
};
```

- Image block at the top with a source line beneath; tutor annotations become `Stroke`s with
  `author: "tutor"` and a shared `groupId` over the image; writing space below.
- `ocrText` goes into the notebook tutor's context.

### 3.5 Migrations

- `clips` with `source_title`, `source_url`, `source_timestamp_sec`, `width`, `height`,
  `ocr_text`; a private `clips` bucket with per-user path policies and signed URLs.

---

## 4. Prompts

- `screen_tutor` v2: always a `focus_region` when annotating; `margin_note` / `write_step`
  beside the focus region rather than on content; notes outside video players.
- `reanchor`: previous annotations + focus description + a new screenshot → updated boxes or
  `not_found`.
- The rule-based safety check covers every text field (`label`, `text`, `latexOrText`).

## 5. Security notes

- The preview window is the **only** place unconfirmed screenshot pixels reach a WebView. The
  main app and overlay never receive image bytes.
- Saved clips are user-confirmed content: private bucket, RLS, signed URLs, deleted with the
  account.
- Window titles and URLs are stored only for saved clips and never logged.
- Clipping a blocked app fails with a friendly message; nothing is captured.
- Protected video that captures as black: say "This video can't be captured".

## 6. Acceptance criteria

- [ ] PDF in Edge at 150% scaling: "help me with question 3" circles key terms and writes a hint
      **beside** it with no overlap of text.
- [ ] Same on a second monitor with different scaling.
- [ ] Scrolling the PDF fades the ink; "show that again" re-places it correctly.
- [ ] "Save this" shows a preview with crop + annotations; Save creates a notebook page with the
      image and **editable** violet strokes in the right positions.
- [ ] YouTube (paused): annotations outside the player with arrows in; the saved page has the
      frame, title and a working timestamp link.
- [ ] Cancel and timeout leave nothing on disk or in storage.
- [ ] Clip refused in a blocked app and in a password field.
- [ ] No screenshot bytes reach the main window or overlay WebView.
- [ ] Latency: "save this" → preview ≤ 400 ms (screenshot reused); Save → page open ≤ 2 s.

## 7. Tests

Placement (free space, sticky note, video rule); coordinate transforms (screen ↔ normalised ↔
crop ↔ page units across DPI and monitors); crop expansion and clamping; WinEvent invalidation;
YouTube URL + timestamp builder; black-frame detection; RLS and storage policies for clips.
