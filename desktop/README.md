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
  covers card numbers, keys and codes it finds with on-device OCR. As of S1 the frame is held
  for 60 s and wiped; nothing is sent anywhere yet.

The web app still runs on its servers (keys stay there): the desktop app needs the Next.js and
API servers, either your `npm run dev` or a deployment.

## Build and run

Needs, on Windows: [rustup](https://rustup.rs) (stable, MSVC), the Visual Studio C++ Build Tools,
and WebView2 (built into Windows 11). From this folder:

```sh
pnpm app      # debug build, opens a window on MEW_APP_URL (default http://localhost:3000)
pnpm bundle   # release build: src-tauri/target/release/bundle/{msi,nsis}/
pnpm icons    # regenerate src-tauri/icons from icon.svg
```

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

## Tests

```sh
cd src-tauri && cargo test && cargo clippy --all-targets -- -D warnings
# Real Windows tests (need a desktop, a GPU and an OCR language): capture a test window, and
# redact a test card number and key from it (threat check 3). Both capture only their own window.
cd src-tauri && cargo test -- --ignored
```

Screen Coach's "nothing on disk" check (threat checklist item 1), from the repo root:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\check-no-screenshots.ps1 -Start
# …use Screen Coach: hold Ctrl+Alt+Space a few times, tray → Look at my screen…
powershell -ExecutionPolicy Bypass -File scripts\check-no-screenshots.ps1 -Check
```

Not done yet: a macOS build (needs a Mac; add the microphone usage description and the
`com.apple.security.device.audio-input` entitlement), code signing, and auto-updates.
