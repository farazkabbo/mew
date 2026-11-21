# Building neb for macOS

A plan for the developer bringing the desktop app to the Mac. Read
[ARCHITECTURE.md](ARCHITECTURE.md) first. This guide assumes you know how the pieces fit.

## Where things stand

- **The web app works on a Mac today,** in any browser. You can develop and test everything in
  `frontend/`, `backend/` and the packages on a MacBook.
- **The desktop app is Windows-only.** It has never been built on macOS. The product decision
  so far was "Windows first, macOS later" ([SCREEN_COACH.md](SCREEN_COACH.md) and
  [HANDOFF.md](HANDOFF.md) §10). This guide is the plan for "later".
- **About 40% of Screen Coach builds anywhere:** roughly 11,000 of its 26,000 lines are
  platform-neutral Rust (geometry, protocol, marks, ink planning, privacy rules).
  - **About 11,400 lines** are only built on Windows, mostly because they call into
    `desktop/src-tauri/src/screen/win/`.
  - **`win/` itself** is about 3,800 lines, where every Windows API call lives. That's the part
    that needs a Mac version. The rest needs re-wiring, not rewriting.
- **On a non-Windows build,** `lib.rs` already compiles a cut-down app: the main window
  showing the web app, plus review reminders. No Screen Coach, sign-in, updater or tray hotkeys.

## 0. Set up the Mac

```sh
xcode-select --install                       # Apple's compilers and SDK
curl https://sh.rustup.rs -sSf | sh          # Rust (stable)
brew install node@24 uv                      # or install Node 22+ and uv another way
npm install -g pnpm@12.14.0
git clone https://github.com/farazkabbo/mew && cd mew
pnpm install && (cd backend && uv sync)
```

Then follow [ONBOARDING.md](../ONBOARDING.md) to get the web app running, in local mode first,
with no keys.

**Never run servers with the live keys.** The repo's `.env.local` on the owner's PC holds
production keys. Ask for test keys, or point at the test copy ([PREVIEW_SETUP.md](PREVIEW_SETUP.md)).
`scripts/dev-staging.ps1` is PowerShell; on a Mac, set the same variables in your shell before
`pnpm dev`.

## 1. First milestone: it compiles and opens

```sh
pnpm --filter @mew/desktop app        # tauri dev
```

Expect compile errors first. Things to check:

- **`additional_browser_args(BROWSER_ARGS)`** in `lib.rs` holds WebView2 (Edge) flags. Gate it
  `#[cfg(windows)]`. macOS uses WKWebView, which takes no such flags.
- **`tauri.conf.json`** has `"targets": ["nsis", "msi"]` and Windows-only bundle settings. Add a
  macOS section, below, and use targets `["app", "dmg"]` on Mac, through a
  `tauri.macos.conf.json` override.
- **Icons:** run `pnpm --filter @mew/desktop icons`, which runs `tauri icon icon.svg`, to make
  `icon.icns`.

**Done when:** the window opens on the web app (`MEW_APP_URL=http://localhost:3000`), the tray
icon shows, and `cargo test --lib` and `cargo clippy --all-targets -- -D warnings` pass on the
Mac. Report back before going further.

## 2. Structure: one interface, two platforms

Don't fill the code with `#[cfg]`. Instead:

1. **Put a trait in front of the platform code.** Add `screen/platform.rs`, with a trait (or a
   set of functions) for what `screen/win/` provides today: capture, OCR, input, credential
   store, HTTP, crypto, and so on. `win/` implements it unchanged.
2. **Add `screen/mac/`** implementing the same thing.
3. **Widen the gates.** Change `#[cfg(windows)]` on the modules above `win/` (`ask`, `circle`,
   `coach`, `sign_in`, `overlay`, …) to `#[cfg(any(windows, target_os = "macos"))]`, and make
   them call the interface instead of `win::` directly.
4. **Keep the Windows build green the whole time.** Every change must still pass on Windows.

## 3. What each Windows module becomes on the Mac

| `screen/win/`      | What it does                                | macOS equivalent                                                                          | Note                                                          |
| ------------------ | ------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `credential.rs`    | Device token in Credential Manager          | **Keychain** (`SecItemAdd`/`SecItemCopyMatching`)                                         | Do this first: sign-in needs it                               |
| `http.rs`          | HTTPS client (WinHTTP)                      | `NSURLSession`, or a Rust client                                                          | Must send `Authorization` and `X-Neb-Device` exactly as today |
| `crypto.rs`        | Random bytes, SHA-256 (CNG)                 | `SecRandomCopyBytes`, CommonCrypto `CC_SHA256`                                            | Used for PKCE and device ids                                  |
| `capture.rs`       | One frame of a window or monitor            | **ScreenCaptureKit** (`SCScreenshotManager`, macOS 14+)                                   | Needs **Screen Recording** permission                         |
| `encode.rs`        | JPEG encoding (WIC)                         | ImageIO (`CGImageDestination`)                                                            |                                                               |
| `ocr.rs`           | Find text to cover before upload            | **Vision** (`VNRecognizeTextRequest`)                                                     |                                                               |
| `uia.rs`           | Is a password field focused?                | Accessibility API: focused element role `AXSecureTextField`                               | Privacy-critical (see below)                                  |
| `input.rs`         | Hold keys, mouse button, cursor             | `CGEventSourceKeyState`, `NSEvent` modifier flags and location; an event tap for the hold | Needs **Accessibility** and **Input Monitoring** permission   |
| `pen_input.rs`     | Tablet pen position                         | `NSEvent` tablet events                                                                   | Can come later                                                |
| `target.rs`        | Foreground window, monitor under the cursor | `NSWorkspace.frontmostApplication`, `CGWindowListCopyWindowInfo`, `NSScreen`              | App ids become bundle ids, not `.exe` names                   |
| `winevent.rs`      | Follow the window ink is drawn on           | `AXObserver` (window moved or resized)                                                    |                                                               |
| `indicator.rs`     | Violet edges while capturing                | A transparent, click-through `NSWindow` or Tauri window                                   | Privacy-critical (see below)                                  |
| `clipboard.rs`     | Read copied text (on request)               | `NSPasteboard`                                                                            |                                                               |
| `media_session.rs` | What media is playing                       | No public API (MediaRemote is private)                                                    | Skip, and degrade gracefully                                  |
| `system.rs`        | Mic permission, calls, screen sharing       | `AVCaptureDevice` authorization; screen-share detection is limited                        |                                                               |
| `test_window.rs`   | A window for capture tests                  | A test `NSWindow`                                                                         | So tests never capture your real screen                       |

**Also platform-specific outside `win/`:**

- **Overlays** (`overlay.rs`): transparent, always-on-top, click-through windows. On macOS,
  enable `macOSPrivateApi` in the Tauri config for transparency, and use
  `set_ignore_cursor_events`.
- **Private windows** (`privacy/private_window.rs`): the lists use `.exe` names (`msedge.exe`
  and others). Add the macOS bundle ids: Safari, Chrome, Edge, Firefox, Arc, Brave.
- **Summon keys:** Ctrl+Alt remains the Windows hold gesture. The Mac app registers
  **Control+Shift+N (⌃⇧N)**: N for Neb, invoking the notebook summon action from any app
  while Neb is running. It restores hidden/minimized Neb. This deliberately uses three keys
  to avoid common Mac commands and Control+Option (VoiceOver). It does not capture the screen
  or start the microphone; use the notebook mic to speak. Settings, the shortcut sheet and
  guide check native registration status; if unavailable, use Ask Neb in the menu bar or the
  notebook dot. Older native builds fall back safely. Mac Control+Option does not activate
  the notebook hold gesture.
- **Updater** (`updates.rs`, Windows-only now): the Tauri updater supports macOS (`.app.tar.gz`).

**Rust crates:** the `objc2` family (`objc2-app-kit`, `objc2-foundation`,
`objc2-screen-capture-kit`, `objc2-vision`) and `security-framework` for the Keychain. These are
new dependencies, so **ask the owner before adding any**, and pin exact versions like the rest
of `Cargo.toml`.

## 4. The privacy rules carry over exactly

These are product promises, not Windows details. They come from
[SCREEN_COACH.md](SCREEN_COACH.md) and HANDOFF.md's security invariants. The Mac build must keep
every one:

- **The capture indicator:** every capture shows the violet edges, held for the whole capture.
  The Windows build has a test over every capture call site; add the same for Mac.
- **Never capture** a focused password field, a private browser window, or a blocklisted app.
- **No screenshots on disk.** Frames stay in memory, are cropped, have text covered, and are
  then sent. There's a Windows check script, `scripts/check-no-screenshots.ps1`; write the Mac
  equivalent.
- **Capture only** the circled window or region, never more.
- **The device token** lives only in the Keychain, never in a file or a log.

## 5. App bundle, permissions, sign-in

- **`Info.plist` usage strings** (Tauri `bundle.macOS`):
  - `NSMicrophoneUsageDescription`: speaking questions.
  - `NSScreenCaptureUsageDescription`: what neb sees when you circle.
  - Accessibility and Input Monitoring don't use strings. The user grants them in System
    Settings, so add an onboarding step that explains them and opens the right pane.
- **Entitlements:** `com.apple.security.device.audio-input`. Leave the app outside the App
  Sandbox: screen capture and accessibility need that, and it's how we'd distribute anyway
  (a DMG, not the App Store).
- **Deep links (`neb://`):** on macOS they register from `CFBundleURLTypes` in the bundled app,
  not at run time. In `tauri dev`, sign-in falls back to **polling**, which already exists, or
  you test from a built `.app` in `/Applications`.
- **Sign-in on the server:** the desktop app sends `device=windows`. Add `mac` to:
  - the `Device` enum in `frontend/src/app/(app)/desktop/authorize/page.tsx`;
  - `DEVICES` in `frontend/src/features/desktop/AuthorizeDesktop.tsx` ("a Mac");
  - the desktop app's sign-in URL.
- **The website** (`neb_web`, `/download`): Mac visitors currently see "Windows-only for now"
  and an email box. When a signed build exists, offer the `.dmg`.

## 6. Signing and shipping

- **Signing needs an Apple Developer Program membership** ($99 a year). Without it, macOS
  blocks the app ("can't be opened") for everyone but you. This is a paid service, so **the
  owner decides**.
- **The release pipeline:**
  1. Sign with a "Developer ID Application" certificate.
  2. **Notarize** with `notarytool` (Tauri does it with `APPLE_ID`, `APPLE_PASSWORD` and
     `APPLE_TEAM_ID`).
  3. Staple, then ship the `.dmg`.
  4. Build a universal binary (`--target universal-apple-darwin`) so Intel and Apple Silicon
     Macs both work.
- **Updates:** a separate macOS entry in the updater manifest, signed with the same minisign
  key as Windows ([DESKTOP_RELEASE.md](DESKTOP_RELEASE.md)).

## Suggested order

1. Compiles and opens (section 1), plus the platform interface (section 2) with Windows still
   green.
2. **Sign-in:** Keychain, HTTP, crypto, polling. The app connects and shows "8 of 8 left".
3. **Capture, minimal:** permissions onboarding, the indicator, capturing the frontmost window,
   the password-field check, JPEG. One circled question works end to end.
4. **Overlays and drawing:** the explanation draws on screen.
5. **Privacy parity:** private windows, the blocklist, OCR covering, the no-disk check.
6. **The rest:** coach mode, notes check, media, pen, the updater.
7. **Signing, notarizing, the DMG,** and the website's Mac download (once the owner has decided
   on the Apple membership).

After each step, write a short report of what works, what was tested, and what's left. That's
how the team works ([HANDOFF.md](HANDOFF.md)).

## Testing against the preview

The test copy works from a Mac too:

```sh
MEW_APP_URL=https://neb-app-git-feat-launch-limits-farazkabbos-projects.vercel.app \
  pnpm --filter @mew/desktop app
```

It runs the fake model, so asking costs nothing. Ask the owner to reset your question count in
the test database when you run out.
