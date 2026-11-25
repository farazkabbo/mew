# Testing cursor modes and Handoff

Two features merged to `main` on 2026-11-24, and both need testing by hand on a real Windows laptop:

- **Cursor modes**: DO IT, SHOW ME and CATCH ME. Spec: [CURSOR_MODES.md](CURSOR_MODES.md).
- **Handoff**: hand your work to a teammate from the exact moment you stopped. It's still being
  built and stays off unless `HANDOFF_ENABLED=1`. Spec: [HANDOFF_FEATURE.md](HANDOFF_FEATURE.md).

The automated tests already pass on CI. The manual checks below cover what those tests can't:
real apps, real accounts, a mouse and trackpad, and several screens.

When something fails, report the step number, what you expected and what you saw. Include
screenshots, but **cover anything private** in them: emails, names and anything on screen that
isn't yours to share.

When something is slow or Neb didn't hear you, also attach **Neb's log**:
`%LOCALAPPDATA%\app.mew.desktop\logs\neb.log` (paste that into File Explorer's address bar). Each
line has the time, so it shows where a request spent its time: the keys going up, the words
arriving (`heard N characters`; `0` means the words were lost), how the meaning was decided and
how long it took, the screen picture, and the answer or chore. It never holds what you said,
what was on screen or file names. Installed (release) builds only; the dev build prints to its
console instead.

---

## 0. Setup

### What you need

- A Windows 10 or 11 laptop with a mouse **and** a trackpad. A second monitor is a bonus.
- The repo, set up as described in [ONBOARDING.md](../ONBOARDING.md): Node 24, pnpm, Rust and uv.
- For Handoff: **two Neb accounts** (sender and receiver), plus a third to check that strangers
  are blocked. A private browser window works for the second account.
- Git installed and a git repo with a few uncommitted changes, for Handoff's "Pick up from here".

### Run the desktop app from the repo

The installed release doesn't have these features yet, so run the dev build:

```
pnpm install
pnpm --filter @mew/desktop app
```

By default it talks to the production web app. To point it at a local web app instead, set
`MEW_APP_URL=http://localhost:3000` before starting it. Only `https` addresses and `localhost`
are accepted.

### Turning Handoff on

Handoff needs sign-in, so test it against the deployed app with the beta flag, not in local
mode. Ask the owner to set these in Vercel and redeploy (don't set them yourself):

| Variable             | Value                                                                  |
| -------------------- | ---------------------------------------------------------------------- |
| `HANDOFF_ENABLED`    | `1`                                                                    |
| `HANDOFF_BETA_USERS` | the testers' account emails, comma-separated (never `*` in production) |
| `HANDOFF_KEY_SECRET` | `openssl rand -base64 32`. Never change it once real handoffs exist    |
| `CRON_SECRET`        | `openssl rand -base64 32`                                              |

The database migration (`20261124000000_handoffs.sql`) is already applied to production. The
Render backend must be running the latest `main`.

### Ground rules while testing

- **Never commit a `.env` file or a real key.** Don't run servers with `neb_web/.env.local`: it
  holds live keys.
- Test CATCH ME and DO IT rename on **test files and test email threads**, never on real work.
- Handoff sends screenshots of your screen to a teammate. Use a test screen with nothing private on it.

---

## 1. Automated tests (run these first)

From the repo root:

```
pnpm format:check
pnpm --filter '!@mew/backend' -r lint
pnpm --filter '!@mew/backend' -r typecheck
pnpm --filter '!@mew/backend' -r test
cd backend && uv run --frozen pytest && cd ..
cd desktop/src-tauri && cargo test && cargo clippy -- -D warnings && cd ../..
```

The e2e tests take about 10 minutes. They use no keys and spend no credits:

```
cd frontend
E2E_CHANNEL=chromium E2E_BASE_URL=http://localhost:3123 CI=1 pnpm e2e
```

On a Mac or Linux machine, the two "every U1 component renders" screenshot tests are skipped,
because their reference images exist only for Windows. If mypy reports an error locally that CI
doesn't, it's a stale cache: run `uv run mypy --no-incremental`.

---

## 2. Cursor modes

**Before you start:** turn Screen Coach on and connect it. In its settings, open **Cursor**, read
the CATCH ME note and turn CATCH ME on.

| #   | Test                     | Steps                                                                                                                                                                                                                                                                                                                                                                               | Pass if                                                                                                                                                                                                                                                                                    |
| --- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Debug view               | Tick "Show the predicted endpoint live". Move the mouse towards buttons in any app. Repeat on a monitor placed left of or above the main one, and at 100 %, 150 % and 200 % scaling.                                                                                                                                                                                                | A dot and a ring lead the cursor, and the likeliest buttons glow. The caption's frame time stays under 2 ms. They line up on every monitor and at every scaling.                                                                                                                           |
| 2   | Record traces            | Tick "Record mouse traces". Click about 100 ordinary targets with the mouse, then about 100 with the trackpad. Copy `%APPDATA%\…\cursor-traces` into `tests/traces` and run `cargo test --release -- replay_report --nocapture`.                                                                                                                                                    | The report runs. Write down the false-intervention rate and send it to the owner.                                                                                                                                                                                                          |
| 3   | SHOW ME                  | Open Windows Settings, hold **Ctrl+Alt** and say "how do I turn on dark mode?". Follow the path. Then head for the wrong item and slow down. Click a wrong item once. Finish the lesson, then ask again three more times.                                                                                                                                                           | A dotted path leads to Personalization, then to Colors. Heading the wrong way grows Colors and you hear one word ("below"/"left"). A wrong click: Neb says what opened and re-plans. Each repeat gives less help: full path → next button only → corrections only → "You've got this one". |
| 4   | DO IT: find              | Put a file such as `lease.pdf` in Documents and say "find my lease PDF". Then try it with two similar files.                                                                                                                                                                                                                                                                        | The file opens, and a 2-second caption says "Found lease.pdf in Documents → …". With two similar files, a dialog asks which one.                                                                                                                                                           |
| 5   | DO IT: setting           | Say "turn on dark mode for me", then say it again, then "show me how".                                                                                                                                                                                                                                                                                                              | Dark mode comes on (apps and taskbar) without Settings opening, and no question is used up. The second time, Neb says it's already on. "Show me how" starts a lesson.                                                                                                                      |
| 6   | DO IT: recipe            | On a recipe website, say "save this recipe". Then try it on a cooking video with no recipe data.                                                                                                                                                                                                                                                                                    | A clip lands in a "Recipe Book" notebook with the ingredients and steps, and no question is used up. On the video, it uses one question.                                                                                                                                                   |
| 7   | DO IT: rename            | In Explorer, select 5 **test** photos and say "rename these photos by date". Press Cancel once, then Rename. Then tray icon → **Undo rename**.                                                                                                                                                                                                                                      | A before → after table appears. Cancel changes nothing, Rename renames them, and Undo puts every name back.                                                                                                                                                                                |
| 7b  | DO IT: rename on request | In Explorer, select 3 **test** files and say "rename these to trip". Press Rename, then say "undo the rename". Then select one file and say "put 2026 in front of this name".                                                                                                                                                                                                       | A before → after table shows Trip 1, Trip 2, Trip 3 with each extension kept. Rename renames them, and undo puts every name back. The second request adds "2026 " to the front.                                                                                                            |
| 8   | CATCH ME                 | In Outlook or Gmail, open a test thread with 6 or more people and head for **Reply all**. Write "attached" with no file attached and head for **Send**. Edit Notepad without saving and head for **×**. Select a folder in Explorer and head for **Delete**. In Windows Terminal, type `git reset --hard` (**don't press Enter**). Try "Not a mistake" once, then tray → **Pause**. | Each one shows an amber glow, a line and a chip (Continue / Not a mistake / Snooze). Each warns once, then stays quiet for 2 minutes. "Not a mistake" makes that warning less eager in that app. Pause stops all of them. The chip never covers the button and never blocks your click.    |
| 9   | Silence                  | With CATCH ME on, use the computer normally for 10 minutes.                                                                                                                                                                                                                                                                                                                         | No false warnings, and Task Manager shows Neb idle near 0 % CPU.                                                                                                                                                                                                                           |

**At no point** should SHOW ME or CATCH ME move your cursor, block a click or type for you. If you see
any of that, stop and report it straight away.

---

## 3. Handoff

You need the **sender** signed into the desktop app and the **receiver** in a browser. The steps
below are the checklist from [HANDOFF_FEATURE.md](HANDOFF_FEATURE.md#manual-checklist-a-real-windows-laptop-signed-in-handoff_enabled1),
with more detail.

| #   | Test                   | Steps                                                                                                                                                                                      | Pass if                                                                                                                                                                                     |
| --- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Timeline               | Screen Coach settings → **Handoff** → tick "Keep a 24-hour timeline for handoffs". Circle and ask about 3–4 things, one of them showing an error message. Switch between a couple of apps. | "What's in the timeline now" lists the moments and app switches. With the timeline off (the default), nothing is recorded.                                                                  |
| 2   | Preview                | Tray icon → **Hand off… (being built)**. Put a fake email address on screen in one of the moments beforehand.                                                                              | Within about 6 seconds a preview shows a summary (where it stands, what was tried, what's blocking, what's next) and the moments. The email is covered, and a badge counts what was hidden. |
| 3   | Editing before sending | In the preview, drag a box over part of a picture, untick one moment and edit the summary.                                                                                                 | The box is blurred, the unticked moment isn't sent and your edits are kept. **Nothing is sent until you press Send.**                                                                       |
| 4   | Send                   | Send it to the receiver's email. Nothing is emailed yet, so copy the link from the preview and give it to the receiver.                                                                    | Sending finishes, and the link looks like `…/h/<id>`.                                                                                                                                       |
| 5   | Open as the receiver   | Sign in as the receiver and open the link. Play the walkthrough. Ask one question the handoff covers and one it doesn't. Send a reply.                                                     | The handoff opens and the walkthrough plays. The covered question is answered and points to a moment. The other gets "… didn't cover that. Want to ask them?". The sender sees the reply.   |
| 6   | Signed out             | Open the link in a private window without signing in.                                                                                                                                      | Only the sender's first name and a sign-in prompt. No title, summary or pictures.                                                                                                           |
| 7   | Stranger               | Sign in as a **third** account and open the link.                                                                                                                                          | "This handoff wasn't shared with you". Nothing of the content shows.                                                                                                                        |
| 8   | Inbox                  | Open `/handoffs` as the sender, then as the receiver.                                                                                                                                      | The sender sees it under sent, with who opened it and when. The receiver sees it as received.                                                                                               |
| 9   | Pick up from here      | Sign into the desktop app as the receiver and open the handoff. Have uncommitted changes in a git repo. Choose **Pick up from here**.                                                      | Every step asks before it runs. With uncommitted changes, git offers to stash or cancel and never throws your work away. A command step only copies the command; it never runs it.          |
| 10  | Revoke                 | As the sender, revoke the handoff. As the receiver, reload the page.                                                                                                                       | The receiver sees that it was revoked, and the content is gone.                                                                                                                             |
| 11  | Expiry                 | Send one with the shortest expiry (1 day) and check it the next day.                                                                                                                       | It shows as expired and no longer opens.                                                                                                                                                    |
| 12  | Flag off               | Use an account **not** in `HANDOFF_BETA_USERS`.                                                                                                                                            | Handoff doesn't work for them. The tray item still shows, but sending fails, and `/handoffs` and links answer "not found".                                                                  |

### Known gaps (don't report these)

- **No emails are sent.** The link has to be shared by hand.
- **Teams aren't built.** You can hand off to individual emails only, up to 5.
- **`neb://` links may not open the dev build**, because only the installed app registers them. Open
  the handoff from inside the desktop app instead.
- **Snapshots don't include the terminal** or the text selected in an app yet.
- **Voice speed controls aren't built.**

### Privacy checks (report straight away if any fails)

- A password, API key or email shown on screen is **covered** in the preview and in what the
  receiver sees.
- The receiver can't open the handoff after it's revoked or has expired.
- Someone not on the handoff never sees its title or contents.

---

## Where to report

Open a GitHub issue for each failure, titled `[cursor]` or `[handoff]` plus the step number,
for example "[handoff] 7: stranger saw the title". Include what you expected, what you saw,
Windows version and display scaling. Cover anything private in screenshots before attaching them.
