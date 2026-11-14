# Shipping the Neb desktop app

A plain guide to building the app, getting it to users and updating it. The exact commands are also
in [desktop/README.md](../desktop/README.md), under "Releasing an update".

## What users do

1. Download `Neb_<version>_x64-setup.exe` from the website.
2. Run it, then sign in.

That's all. The installer sets up Neb for that Windows user, and later updates arrive inside the app.

Two things they may notice:

- **A Windows SmartScreen warning**, until the `.exe` is signed with a code-signing certificate.
- **A short extra download** if the PC doesn't have WebView2. Windows 11 already has it.

## Where the build goes

`pnpm bundle:release`, run in `desktop/`, creates these files in
`desktop/src-tauri/target/release/bundle/nsis/`:

| File                              | What it's for                                                               |
| --------------------------------- | --------------------------------------------------------------------------- |
| `Neb_<version>_x64-setup.exe`     | The installer. The website's download button uses it.                       |
| `Neb_<version>_x64-setup.exe.sig` | Its signature. It goes inside `latest.json`, so don't upload it.            |
| `latest.json`                     | Tells installed apps the newest version. `pnpm update-manifest` creates it. |

This folder is not in Git and stays on the computer that built it. Users only get these files once
you upload the `.exe` and `latest.json` to a public host.

## Do you need a new release?

| What changed                                  | What to do                               |
| --------------------------------------------- | ---------------------------------------- |
| The website (`frontend/`) or backend          | Just deploy. Users get it automatically. |
| Anything in `desktop/` (tray, overlays, Rust) | Publish a new desktop release.           |

The app is a window onto the website, which is why most changes don't need a new `.exe`.

## How updates work

Neb can't tell that a new version exists until the devs publish one. It keeps asking a fixed web
address whether there's something newer, and that address is a small file called `latest.json`.

### On the user's computer

1. **Neb asks:** 30 seconds after it opens, and every 6 hours while it's running, Neb reads
   `latest.json` from the host.
2. **Neb compares:** the file says something like "newest version is 0.2.0, and here's the download
   link and signature". If the user has 0.1.0, that counts as an update. If they already have 0.2.0,
   nothing happens and they never notice.
3. **Neb downloads:** the new installer downloads in the background while they keep working, and Neb
   checks its signature. If the signature doesn't match, Neb rejects the download.
4. **Neb tells them:** they get a notification saying the new version is ready, and "Restart to
   update" appears in the tray.
5. **They choose when:** when they click it, the installer runs with a small progress bar and Neb
   reopens on the new version. Their notes aren't touched by this. Neb never restarts by itself.

Neb keeps running in the tray when its window is closed, so the 6-hour check still happens. If the PC
is offline, the check fails quietly and tries again at the next one.

### What the devs do for each update

Say the devs fixed a bug in `desktop/`:

1. **Raise the version:** change it from `0.1.0` to `0.2.0` in the three version files.
2. **Build it:** run `pnpm bundle:release`, which creates the new installer and signs it with the
   private key.
3. **Create the file:** run `pnpm update-manifest`, which writes the new `latest.json`.
4. **Upload both:** put the `.exe` on the host first, then replace `latest.json`.

That's the whole job. There's no list of users and nothing is sent to anyone. As soon as
`latest.json` is replaced, each installed copy finds the update at its next check, so everyone whose
PC is on and running Neb should have it within about 6 hours.

If the change is only to the website or backend, the devs just deploy as usual. Users get it the next
time Neb loads the page, with no update prompt.

The full commands are under [Publishing a release](#publishing-a-release).

### Why this has to be set up first

The address and the public key are built into the copy a user installs. If that copy was built before
they were set, it has nowhere to look, so that user would have to download the next version by hand.
That's why the key and host need to be in place before the first public release.

## Setup before the first release

Done on 2026-11-14:

1. **The signing key** is at `~/.tauri/neb-updater.key` on the developer's PC, with its password in
   `~/.tauri/neb-updater.password`. Keep both in a password manager, and never commit them. If you
   lose them, installed apps can't accept another update. If they leak, someone else could sign an
   update.
2. **The address** every installed copy checks is `https://app.myneb.si/desktop/latest.json`. It's a
   route in the web app (`frontend/src/app/(site)/desktop/latest.json/route.ts`) that redirects to
   the newest **GitHub Release** of `farazkabbo/mew`. To host the files somewhere else later, set
   `DESKTOP_UPDATE_MANIFEST_URL` on Vercel. Installed copies keep working, because their built-in
   address doesn't change.
3. **`desktop/src-tauri/tauri.release.conf.json`** holds the public key and that address.

The website (myneb.si) isn't involved, so releases don't put a download on it. On launch day, copy
the same `.exe` to where `/download` points.

Still optional but recommended: **a code-signing certificate**, to reduce the SmartScreen warning.
It's separate from the update key.

## Publishing a release

1. Raise the version in `desktop/src-tauri/tauri.conf.json`, `desktop/src-tauri/Cargo.toml` and
   `desktop/package.json`. Installed apps only take a **greater** version.

2. Build it, in Git Bash from the repo root:

   ```sh
   export MEW_APP_URL="https://app.myneb.si"
   export TAURI_SIGNING_PRIVATE_KEY="$HOME/.tauri/neb-updater.key"
   export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$(cat ~/.tauri/neb-updater.password)"
   pnpm --filter @mew/desktop bundle:release

   V=0.2.0   # the new version
   pnpm --filter @mew/desktop update-manifest      --base-url "https://github.com/farazkabbo/mew/releases/download/desktop-v$V"      --notes "What changed"
   ```

   Don't forget `MEW_APP_URL`. Without it, the app opens `localhost:3000` and users see "localhost
   refused to connect".

3. On GitHub, **Releases → Draft a new release**:
   - Tag: `desktop-v0.2.0` (the same as in `--base-url`), target `main`.
   - Attach `Neb_0.2.0_x64-setup.exe` **and** `latest.json` from
     `desktop/src-tauri/target/release/bundle/nsis/`. Don't attach the `.sig`.
   - Leave **Set as the latest release** ticked, then **Publish**.

   Installed apps see the new version at their next check. To pull a bad release, delete it (or
   untick "latest") and the previous release becomes the newest again. Copies that already
   updated stay on it until a newer version is published.

4. Hand testers the `.exe` from the release page, or wait for launch day for the website.

## Before relying on this

These haven't been tested yet:

- Updating from one installed version to the next. The first release (0.1.0) needs the
  `/desktop/latest.json` route deployed to app.myneb.si; then publish 0.1.1 and watch an installed
  0.1.0 update.
- "Show Neb in screen shares and recordings" in a real OBS or Teams capture.
