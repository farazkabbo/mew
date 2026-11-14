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

Do these once. **Do them before giving the app to anyone:** a copy built without the key and address
can't update itself, so those users would have to reinstall by hand.

1. **Create the signing key.** In `desktop/`, run:

   ```sh
   pnpm tauri signer generate -w ~/.tauri/neb-updater.key
   ```

   Keep the private key and its password in a password manager, and never commit them. If you lose
   them, installed apps can't accept another update. If they leak, someone else could sign an update.

2. **Host the files on the waitlist site**, `https://www.myneb.si/` (a separate repo, on Vercel). Put
   the `.exe` and `latest.json` in its public `desktop/` folder. Keep that address working for good,
   because every installed copy has it built in.

3. **Fill in `desktop/src-tauri/tauri.release.conf.json`** and commit it:
   - `pubkey`: the contents of `neb-updater.key.pub`. This key is public, so committing it is safe.
   - `endpoints`: `["https://www.myneb.si/desktop/latest.json"]`

4. **Optional but recommended: buy a code-signing certificate** to reduce the SmartScreen warning.
   It's separate from the update key.

## Publishing a release

1. Raise the version in `desktop/src-tauri/tauri.conf.json`, `desktop/src-tauri/Cargo.toml` and
   `desktop/package.json`.

2. Build it, in Git Bash from `desktop/`:

   ```sh
   TAURI_SIGNING_PRIVATE_KEY="<contents of neb-updater.key>" \
   TAURI_SIGNING_PRIVATE_KEY_PASSWORD="<its password>" \
   MEW_APP_URL="https://<the deployed web app>" \
   pnpm bundle:release

   pnpm update-manifest --base-url "https://www.myneb.si/desktop" --notes "What changed"
   ```

   Don't forget `MEW_APP_URL`, and don't set it to the waitlist site. Without it, the app opens `localhost:3000` and users see "localhost
   refused to connect".

3. Copy the `.exe` and `latest.json` into the waitlist repo and deploy it. Installed apps can see the
   new version as soon as that deploy is live.

4. Point the website's download button at the new `.exe`.

## Before relying on this

These haven't been tested yet:

- Updating from one installed version to the next, which needs the real key and host.
- "Show Neb in screen shares and recordings" in a real OBS or Teams capture.
