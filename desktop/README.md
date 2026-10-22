# Mew for Windows (desktop app)

A [Tauri v2](https://v2.tauri.app) shell around the Mew web app. The window shows the web app
(the same pages, in Edge WebView2), and adds what a web page can't do:

- **Ctrl+Shift+M from any app:** Mew comes forward and listens, as if its mascot was tapped.
- **Tray icon:** closing the window keeps Mew in the tray (Open, Ask Mew, Quit).
- **Review reminders:** a Windows notification when concepts are due for review (at most one
  every 30 minutes; the web app checks `/api/review` and asks the shell to notify).

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

## Tests

```sh
cd src-tauri && cargo test && cargo clippy --all-targets -- -D warnings
```

Not done yet: a macOS build (needs a Mac; add the microphone usage description and the
`com.apple.security.device.audio-input` entitlement), code signing, and auto-updates.
