# Shipping the Neb desktop app

Everything a developer needs to build the Windows installer, sign it, publish an update and look
after the keys. This is the one guide. [desktop/README.md](../desktop/README.md) covers running the
app in development.

## In short

- The desktop app is a window onto the web app at **https://app.myneb.si**. Web and backend changes
  reach every user when they deploy, so **only changes in `desktop/` need a new installer.**
- A release is an `.exe` plus a small `latest.json`, published as a **GitHub Release** of
  `farazkabbo/mew`.
- Installed apps check **https://app.myneb.si/desktop/latest.json**, which redirects to the newest
  release. They then download, verify and offer the update themselves.
- Every update must be signed with **the update key**. Without it, there are no more updates, ever.

## The keys and the password

| What                              | Where                                                   | Secret?             |
| --------------------------------- | ------------------------------------------------------- | ------------------- |
| Update private key                | `~/.tauri/neb-updater.key`, on the PC that generated it | **Yes**             |
| Its password                      | `~/.tauri/neb-updater.password`, next to it             | **Yes**             |
| Update public key                 | `pubkey` in `desktop/src-tauri/tauri.release.conf.json` | No, committed       |
| Code-signing certificate (future) | not bought yet                                          | Yes, when it exists |

`~` is `C:\Users\<you>`. The pair was generated on 2026-11-14 with:

```sh
pnpm --filter @mew/desktop exec tauri signer generate -w ~/.tauri/neb-updater.key -p "<password>" --ci
```

**Rules:**

- **Back up both files** in the team's password manager, and share them only through it: never in
  chat, email, an issue or the repo.
- **If they're lost,** installed apps can never accept another update. Every user would have to
  download a new installer by hand, built with a new key.
- **If they leak,** someone else could sign an update that installed apps would accept. They would
  still need control of the update address or the GitHub releases, but treat a leak as an
  incident: make a new key, ship a release with it, and ask users to reinstall.
- **Never generate a new pair** while the current one exists. Apps only trust the public key they
  were built with.
- **To build on another PC,** copy both files into that PC's `~/.tauri/`.

**The update key isn't a code-signing certificate.** The update key proves to Neb that an update
came from us. A code-signing (Authenticode) certificate proves it to **Windows**, and removes the
"Windows protected your PC" warning. We don't have one yet, so users click **More info → Run
anyway** on first install. The options are Azure Trusted Signing (cheapest; check its eligibility
rules) or an OV certificate from a certificate authority.

## What's built in, and where

| Setting              | Where                                                         | Value                                                |
| -------------------- | ------------------------------------------------------------- | ---------------------------------------------------- |
| Version              | `tauri.conf.json`, `Cargo.toml`, `package.json` in `desktop/` | `0.1.0`, the same in all three                       |
| The web app it opens | `MEW_APP_URL` **at build time**                               | `https://app.myneb.si`                               |
| Update public key    | `desktop/src-tauri/tauri.release.conf.json`                   | `pubkey`                                             |
| Update address       | `desktop/src-tauri/tauri.release.conf.json`                   | `https://app.myneb.si/desktop/latest.json`           |
| Where that redirects | the web app's `DESKTOP_UPDATE_MANIFEST_URL`                   | unset: the newest GitHub Release of `farazkabbo/mew` |
| `neb://` links       | `tauri.conf.json`, `deep-link`                                | registered by the installer                          |
| WebView2             | `tauri.conf.json`, `webviewInstallMode`                       | downloaded during install if the PC doesn't have it  |

**`MEW_APP_URL` matters.** The app opens `MEW_APP_URL` from the user's environment if it's set,
otherwise the value built in, otherwise `http://localhost:3000`. A build without it shows
"localhost refused to connect" to every user. A tester can point an installed app somewhere else
with `setx MEW_APP_URL "<address>"`, and must undo it with `setx MEW_APP_URL ""`.

**The update address is permanent.** Every installed copy has it built in. It's a route in the web
app ([route.ts](<../frontend/src/app/(site)/desktop/latest.json/route.ts>)) that only redirects, so
the files can move without stranding anyone: set `DESKTOP_UPDATE_MANIFEST_URL` (https only) on the
`neb-app` Vercel project and redeploy. Never delete or rename the route.

## Building the installer

On Windows, in **Git Bash**, from the repo root, on an up-to-date `main`:

```sh
git checkout main && git pull
pnpm install

export MEW_APP_URL="https://app.myneb.si"
export TAURI_SIGNING_PRIVATE_KEY="$HOME/.tauri/neb-updater.key"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$(cat ~/.tauri/neb-updater.password)"
pnpm --filter @mew/desktop bundle:release
```

It takes about 3 minutes and writes to `desktop/src-tauri/target/release/bundle/nsis/`:

| File                              | What it is                                                           |
| --------------------------------- | -------------------------------------------------------------------- |
| `Neb_<version>_x64-setup.exe`     | The installer, about 3 MB. What users run.                           |
| `Neb_<version>_x64-setup.exe.sig` | Its update signature. It goes inside `latest.json`; don't upload it. |

Then write `latest.json`, naming where the `.exe` will be published:

```sh
V=0.1.1   # the version you just built
pnpm --filter @mew/desktop update-manifest \
  --base-url "https://github.com/farazkabbo/mew/releases/download/desktop-v$V" \
  --notes "What changed, in a sentence"
```

**Check before you hand it out:**

- `grep -c "https://app.myneb.si" desktop/src-tauri/target/release/mew-desktop.exe` prints at least
  `1`. If it prints `0`, `MEW_APP_URL` wasn't set, so build again.
- The build printed "Finished 1 updater signature". If it complains about the key or the password,
  the two `TAURI_SIGNING_…` exports are wrong.

**Which build is which:**

| Command               | Updates itself? | Use it for                         |
| --------------------- | --------------- | ---------------------------------- |
| `pnpm tauri dev`      | No              | Development                        |
| `pnpm bundle`         | No              | A quick local installer, no key    |
| `pnpm bundle:release` | **Yes**         | Anything a user or tester installs |

## Publishing an update

Only needed when something in `desktop/` changed: the tray, overlays, island or Rust code.

1. **Raise the version** in all three files: `desktop/src-tauri/tauri.conf.json`,
   `desktop/src-tauri/Cargo.toml` and `desktop/package.json`. Installed apps only accept a
   **greater** version (0.1.0 → 0.1.1 → 0.2.0). Commit it.
2. **Build** and **write `latest.json`**, as above.
3. **Publish on GitHub:** `farazkabbo/mew` → **Releases → Draft a new release**:
   - **Tag:** `desktop-v0.1.1`, exactly matching `--base-url`. Target: `main`.
   - **Attach** `Neb_0.1.1_x64-setup.exe` and `latest.json`, but not the `.sig`.
   - Leave **Set as the latest release** ticked → **Publish release**.
4. **Check:** `curl -sL https://app.myneb.si/desktop/latest.json` shows the new version.

From then on, each running copy picks it up within about 6 hours, or at its next start.

**Pulling a bad release:** delete the release, or untick "latest" on it, and the previous release
is the newest again. Copies that already updated stay on the bad version until you publish a
newer, fixed one, so the usual fix is to ship the next version quickly.

**The repo must stay public** for this. Release files on a private repo need a GitHub login, so
updates would fail. If it goes private, host the two files on another public https address and set
`DESKTOP_UPDATE_MANIFEST_URL` to its `latest.json`.

**Launch day:** the website's `/download` needs the same `.exe` copied to where it points. Releases
on GitHub don't touch the website, and the website doesn't touch updates.

## How the update flow works

The code is [updates.rs](../desktop/src-tauri/src/updates.rs), using the official Tauri updater
plugin.

```
installed Neb 0.1.0
  │ 30 s after start, then every 6 h (or "Check for updates" in the tray or Settings)
  ▼
GET https://app.myneb.si/desktop/latest.json ──302──▶ github.com/…/releases/latest/download/latest.json
  │ { version: "0.1.1", url: "…/Neb_0.1.1_x64-setup.exe", signature: "…" }
  │ not newer → nothing happens, and the user never notices
  ▼ newer
download the .exe in the background (progress shows in Settings)
  │ check its signature against the public key built into 0.1.0
  │ bad signature → thrown away
  ▼
notification: "Version 0.1.1 is ready. Restart from the tray icon when it suits you."
tray and Settings: "Restart to update to 0.1.1"
  │ the user clicks it (Neb never restarts by itself)
  ▼
the installer runs with a small progress bar, closes Neb and reopens it on 0.1.1
```

**Details:**

- **Notes are safe.** They live in the web app's database, not on the PC.
- **Offline,** the check fails quietly and runs again at the next one.
- **Closing the window** leaves Neb in the tray, so the 6-hour check still runs.
- **Until a release exists,** the check gets "not found" and fails quietly. That's normal.
- **Only `bundle:release` builds update.** A copy built with `pnpm bundle`, or before 2026-11-14
  when the key and address were empty, says "Updates are off in this build" and must be replaced
  by hand.
- **Only Settings and the tray can start an update.** The web page in the window can't: the
  plugin's commands are granted to no page.

## Testing a release

**A new installer,** on a PC without a development build of Neb:

1. **Install:** "Windows protected your PC" → **More info → Run anyway** (until we code-sign).
2. **Sign in:** **Sign in** → the browser shows sign-up → sign up → "Connect neb on a Windows PC,
   started just now?" → **Continue** → allow Edge to open neb. Neb greets you.
3. **Ask:** hold **Ctrl+Alt**, circle something on screen and ask. You get an answer, and the
   count of questions left drops by one.
4. **Polling:** sign out, sign in again, and click **Cancel** on Edge's "Open neb?". It still
   connects within about 2 seconds.
5. **Cancelling:** start a sign-in and click **This wasn't me**. Neb says it was cancelled.

**The update path.** This has never been tried end to end, so do it once before launch day:

1. Install 0.1.0 and sign in.
2. Raise the version to 0.1.1, build, write `latest.json` and publish the `desktop-v0.1.1` release.
3. Quit and reopen Neb 0.1.0. Within about 30 seconds you get the notification, and "Restart to
   update to 0.1.1" appears in the tray.
4. Click it. The installer runs, Neb reopens, Settings shows 0.1.1, and you're still signed in.

**Also untested:** "Show Neb in screen shares and recordings" in a real OBS or Teams capture.

## Release history

| Version | Date       | Notes                                                                                                                                                                                                                                                                                                                                                |
| ------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0.1.0   | 2026-11-14 | First signed build. Given to testers directly; no GitHub Release published.                                                                                                                                                                                                                                                                          |
| 0.1.1   | 2026-11-14 | A double tap of Ctrl+Alt opens the island while neb's own window is in front. Built; no GitHub Release published yet.                                                                                                                                                                                                                                |
| 0.1.2   | 2026-11-14 | The island's help levels (Quiet, Hint, Coach, Answer), Watch, and typing into documents. Screen Coach consent version 5 (asked again once). Built; no GitHub Release published yet.                                                                                                                                                                  |
| 0.1.3   | 2026-11-14 | Fixes 0.1.2: the Screen Coach settings window came up blank when opened from the tour, and a double tap did nothing with Screen Coach off (it now says so and opens the settings). Built; no GitHub Release published yet.                                                                                                                           |
| 0.1.4   | 2026-11-15 | What's said to Screen Coach is read by a model (any phrasing; the fixed rules are the fallback), typing writes the whole piece asked for, and holding Ctrl+Alt asks about the screen while Watch is on. Needs the web app deployed with `/api/screen/intent`. Built; no GitHub Release published yet.                                                |
| 0.1.5   | 2026-11-15 | Typing into documents is streamed and typed a key at a time, with whole essays; Neb's hand: its own cursor clicks, scrolls and presses keys when asked (off until “Let Neb click for me” is turned on). Needs the web app deployed with it: `/api/screen/write` streams now, so 0.1.4 can't type against it. Built; no GitHub Release published yet. |
