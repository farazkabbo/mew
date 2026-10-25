# Mew for Windows (desktop app)

A [Tauri v2](https://v2.tauri.app) shell around the Mew web app. The window shows the web app
(the same pages, in Edge WebView2), and adds what a web page can't do:

- **Ctrl+Shift+M from any app:** Mew comes forward and listens, as if its mascot was tapped.
- **Tray icon:** closing the window keeps Mew in the tray (Open, Ask Mew, Quit).
- **Review reminders:** a Windows notification when concepts are due for review (at most one
  every 30 minutes; the web app checks `/api/review` and asks the shell to notify).
- **Screen Coach** (in progress, [docs/SCREEN_COACH.md](../docs/SCREEN_COACH.md)): off until the
  user turns it on in **tray → Screen Coach settings…** (a bundled local page). Once on, holding
  **Ctrl+Alt+Space** (or tray → _Look at my screen_) captures one frame of the foreground
  window in memory, with a violet glow at the screen edges; **Ctrl+Alt+P** pauses. Before
  capturing, the privacy layer (S1) refuses blocked apps, password fields, private browsing
  windows, calls and recordings, and a microphone that's switched off. After capturing, it
  covers card numbers, keys and codes it finds with on-device OCR. When the key comes up, the
  web page sends what you said and Rust uploads the frame with the question. The answer
  streams back and the page speaks it (S2). First connect the app to your account: Screen
  Coach settings → Connect.

The web app still runs on its servers (keys stay there): the desktop app needs the Next.js and
API servers, either your `npm run dev` or a deployment.

## Build and run

Needs, on Windows: [rustup](https://rustup.rs) (stable, MSVC), the Visual Studio C++ Build Tools,
and WebView2 (built into Windows 11). From this folder:

```sh
pnpm app      # debug build, opens a window on MEW_APP_URL (default http://localhost:3000)
pnpm bundle   # release build: src-tauri/target/release/bundle/{msi,nsis}/
pnpm icons    # regenerate src-tauri/icons from icon.svg
pnpm build:shell   # bundle Screen Coach's overlay pages (runs before app/bundle by itself)
```

Screen Coach's overlay pages (the ink overlay, the ink pill, a clip's preview, the Notes Check
panel and coach mode's progress pill) are TypeScript in
`overlay-src/`, bundled by esbuild into `shell/gen/` (gitignored) so they reuse the notebook's
handwriting from `packages/ink`. `pnpm lint`, `pnpm typecheck` and `pnpm test` cover them.

`MEW_APP_URL` picks the web app: set it in the environment when running, or when building (the
build bakes it in as the default). Only `https://` URLs, or `http://` on this machine, are
accepted. For a release, build with the public origin:

```sh
MEW_APP_URL=https://mew.example.com pnpm bundle
```

Windows only shows notifications for installed apps: in `pnpm app` they appear under
PowerShell's name.

## Security

- The window shows a **remote origin**, so it gets no Tauri API by default. One capability,
  created at start-up for exactly the app's origin (`src/lib.rs`), allows one command:
  `notify_due(count, first)`. Rust treats its arguments as untrusted (control characters
  dropped, length capped) and rate-limits it.
- The hotkey, tray and window are handled in Rust; the hotkey reaches the page as a
  `mew:summon` DOM event, so the page needs no permission for it.
- Navigation is limited to the app's origin and Clerk's sign-in pages (`src/origin.rs`).
- Crates are pinned to releases at least 14 days old when added; `Cargo.lock` is committed.
- **Screen Coach** (`src/screen/`):
  - Captures start only in Rust, from the hotkey and tray handlers. No command a page can call
    starts a capture or returns pixels; screenshots never enter a WebView.
  - Its settings live in `%APPDATA%\app.mew.desktop\screen-coach.json`, are enforced in Rust,
    and can be changed only by the bundled page `shell/screen-coach.html`. Its capability is
    local-only and limited to the `screen-coach` window, and the commands check the window
    again.
  - An unreadable or unexpected settings file resets to "off".
  - Frames live in `SecretBytes` (zeroed on drop) and expire after 60 s.
  - JPEG encoding uses WIC into our own buffer, so there are no temp files.
  - Crash reports exclude the heap (`WerSetFlags(NOHEAP)`).
  - The capture glow is excluded from captures (`WDA_EXCLUDEFROMCAPTURE`).
  - Windows' yellow capture border can't be turned off by an unpackaged app; it doubles as
    part of the capture indicator.
  - `windows` is the version Tauri already uses (`=0.62.2`), and `regex` was already in the
    lockfile through Tauri, so no new crate came in.
- **Screen Coach privacy layer** (`src/screen/privacy/`, run in order by `src/screen/pipeline.rs`):
  - Default blocked apps: password managers, Windows Settings (whole), Windows Security,
    sign-in prompts, finance apps, and mail and messaging apps (opt-in). The list is editable,
    matched by executable name, and is a starting point: vendors rename executables.
  - Password fields: UI Automation's `IsPassword` on the focused element. If UI Automation
    can't answer, the capture is refused.
  - Private windows: browser + window-title markers (InPrivate, Incognito, Private Browsing).
  - Calls: another app holding the microphone right now, or a screen recorder running. Mew's
    own voice input (WebView2) doesn't count. The microphone signals come from Windows'
    capability consent store in the registry, which is undocumented, so it's read defensively.
  - Monitor captures black out windows of blocked apps and private browsers.
  - Redaction: Windows.Media.Ocr on a grey copy (at most 2560 px), then pattern detection
    tolerant of OCR look-alikes (`l`/`1`, `O`/`0`), then flat grey boxes (not blur). If OCR
    can't run, nothing is sent.
  - **OCR is best effort.** In testing it skipped a line reading `4111 1111 1111 1111` (runs
    of ones look like bars) while reading realistic card numbers fine. Blocked apps and
    password fields are the hard guarantees; redaction is the safety net.
  - Release-build timings on a dense 1875×1070 window: capture ~60 ms, redaction 125–180 ms,
    downscale ~35 ms, encode ~5 ms.

- **Screen Coach sign-in and asking** (S2: `src/screen/account.rs`, `ask.rs`, `protocol.rs`):
  - The desktop app has its own device token (decision 8): an opaque 256-bit value in Windows
    Credential Manager (`Mew/ScreenCoach/DeviceToken`), valid only for Screen Coach routes. The
    server keeps only its hash.
  - Getting one: PKCE-style. Rust keeps the verifier; the signed-in page sees only the
    challenge and hands back a one-time code (60 s).
  - The main window's origin may call exactly two Screen Coach commands, each re-checked in
    Rust: `screen_coach_ask` (the words of a question; it can't start a capture or read pixels)
    and `screen_coach_link_finish` (a one-time code, accepted only while a connection started
    from the settings page is pending, for up to 5 minutes).
  - Uploads use WinHTTP, straight from a wipeable buffer, with no redirects.
  - Replies are schema-checked in Rust (`protocol::parse_event`) before the page sees them, and
    the page checks them again.
  - Both windows share `BROWSER_ARGS`: wry's defaults plus
    `--autoplay-policy=no-user-gesture-required`, so answers to a hotkey question can play
    aloud.

- **Screen Coach ink and clips** (S3, `docs/SCREEN_COACH_S3.md`, decision 9: `annotate.rs`,
  `ink.rs`, `overlay.rs`, `watch.rs`, `win/winevent.rs`, `clip.rs`, `source.rs`):
  - Three local windows, each loading one bundled page with its own strict CSP, refusing
    navigation and new windows, and allowed only its own commands (a capability per window,
    re-checked in Rust): the ink overlay (`screen_ink_drawn`), the pill (`screen_ink_pill`) and
    the preview (`screen_clip_ready`/`save`/`cancel`).
  - The ink overlay covers one monitor: transparent, click-through, never focused, excluded from
    every capture. It gets the tutor's actions and the on-screen text as **rectangles only**,
    plans the ink with `packages/ink`, and reports the strokes back; Rust checks them (caps,
    finite numbers, on the monitor, plain hex colours) before keeping them.
  - The redacted screenshot and its visible OCR text stay in Rust while the ink is on screen and
    unchanged (at most 5 minutes), for a clip. Words under a redaction box are dropped from the
    kept text, and the redaction rules run again on it.
  - While ink is visible, one thread watches: WinEvents (app switch, move, resize, minimise,
    standard scrolling), a low-level mouse hook (wheel and left-button drags only; nothing is
    recorded) and `GetLastInputInfo` (a key press, without a keyboard hook; Ctrl/Alt chords such
    as our hotkeys don't count). The first change fades the ink, wipes the screenshot and stops
    the thread. Esc is a global hotkey only while ink is visible.
  - The preview is the only WebView that sees screen pixels, and only after the student asked to
    save. Its image comes from `mewclip://` (served from memory, to the preview window only, at a
    one-time path, `Cache-Control: no-store`); its page has `connect-src` for IPC only, no
    context menu and no image dragging. Cancel, or 60 s without a choice, wipes the draft.
  - Saving: crop, near-black check (protected video), JPEG quality 90 at 4:4:4 (WIC; Windows has
    no WebP encoder), at most 2400 px; the crop's visible text; the source (window title, the
    browser's address via UI Automation trimmed to scheme, host and path plus YouTube's `v`/`t`,
    and a video's position from Windows' media session). Uploaded with the device token; the web
    page gets only the clip's id.
  - "Save this" and "show that again" are recognised in Rust (`intent.rs`) and upload nothing to
    the tutor. "Show that again" looks for the focus region's words on a new capture first; only
    if that fails does it ask the server (`/api/screen/reanchor`), whose answer may only move the
    ink.
  - The main window's links that open a new window go to the default browser (https only).
  - `windows-future` (=0.3.2, already in the tree through `windows`) is used directly for the
    media session's async calls.

- **Circle & Ask** (S3.2, `docs/SCREEN_COACH_S3_2.md`, decision 11: `circle.rs`,
  `circle_answer.rs`, `marks.rs`, `pointer.rs`, `circle_steps.rs`, `circle_protocol.rs`,
  `raster.rs`):
  - One tracker thread polls the cursor and left Ctrl + left Alt (`win/input.rs`,
    `GetAsyncKeyState`: no hooks, nothing recorded; AltGr never draws), a frame at a time while
    something moves, ten times a second otherwise, not at all while Screen Coach is off or paused.
  - The mouse is read the same way while draw mode (or "select question") is on: the primary
    button and the cursor, every 8 ms during a drag (`drag.rs`). The overlay page only draws pen
    and touch: a never-activated window's webview doesn't reliably get the mouse on Windows. A
    drag that began before draw mode never becomes a mark.
  - The pointer and the draw overlay are click-through, never focused and excluded from captures;
    the overlay takes the mouse, pen and touch only while drawing, and the keyboard only for
    keyboard drawing (silent mode), then gives the focus back. The card takes the focus only when
    clicked. None of them sees pixels: Rust sends paths and rectangles.
  - The privacy checks run as drawing starts; the first finished mark captures the monitor once,
    which is watched (it fades if the window moves or scrolls) and wiped when the session ends.
    The model gets the marked crop (marks drawn on that copy only) and the window, small; the
    saved picture stays clean, with the marks as the student's strokes.
  - Replies are checked in Rust (`circle_protocol::parse_circle_event`); a step that fails the
    server's safety check aborts the answer and its ink is taken back.
  - Saving waits for the 5-second toast (Undo: nothing is sent); it's never automatic when blocked
    windows were blacked out under the crop, or for a black (protected) picture.

- **Coach mode** (S4, `docs/SCREEN_COACH.md` decision 10: `coach_mode.rs`, `walkthrough.rs`,
  `intent.rs`):
  - The walkthrough lives on the server (`/api/screen/coach/start`, `/resume`, `/step`, device
    token). The desktop keeps its id, step and phase, and checks every reply in Rust
    (`walkthrough::parse_coach_reply`): only a focus region and an arrow may be drawn, and
    speech, title and step numbers are bounded.
  - Captures happen only on the student's action: the hotkey ("done", "I'm stuck"…), or the
    progress pill's Done, Hint, No and Resume. During a walkthrough they're of the monitor under
    the cursor (decision 6; blocked apps blacked out as usual), and the first walkthrough shows a
    one-time notice saying so.
  - The progress pill is an overlay window like the ink pill: never focused, excluded from
    captures, one command (`screen_coach_pill`). Ink drawn for a walkthrough doesn't register Esc
    (Excel and Word need it) and doesn't show the ink pill. Stop from the pill, by voice or from
    the tray; pausing Screen Coach stops the walkthrough (saved), and a reply still on its way
    is dropped.

## Tests

```sh
cd src-tauri && cargo test && cargo clippy --all-targets -- -D warnings
# Real Windows tests (need a desktop, a GPU and an OCR language): capture a test window, and
# redact a test card number and key from it (threat check 3). Both capture only their own window.
cd src-tauri && cargo test captures_a_window covers_a_card -- --ignored
# S2 end to end (dev servers running, Gemini key set): link a device, ask about a test window
# that holds a prompt injection (threat check 4), sign out, and check the token is refused.
MEW_E2E_APP=http://localhost:3000 MEW_E2E_API=http://127.0.0.1:8000 INTERNAL_API_SECRET=… \
  cargo test e2e -- --ignored --nocapture
# Windows' media session (prints what's playing in Edge and Chrome, if anything).
cargo test reads_the_media_session -- --ignored --nocapture
# The overlay pages in a real browser, from the repo's frontend folder (Tauri's bridge stubbed).
cd ../../frontend && E2E_BASE_URL=http://localhost:3100 npx playwright test desktop-overlays clips
```

Screen Coach's "nothing on disk" check (threat checklist item 1), from the repo root:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\check-no-screenshots.ps1 -Start
# …use Screen Coach: hold Ctrl+Alt+Space a few times, tray → Look at my screen…
powershell -ExecutionPolicy Bypass -File scripts\check-no-screenshots.ps1 -Check
```

Not done yet: a macOS build (needs a Mac; add the microphone usage description and the
`com.apple.security.device.audio-input` entitlement), code signing, and auto-updates.
