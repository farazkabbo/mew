# Handoff (Windows) — being built

> Stop mid-task, say "hand this off to Rahbir", and your teammate picks up from that exact moment.
> neb explains where you got to, out loud, with replays. No catch-up meeting.

Status: built behind a flag (`HANDOFF_ENABLED=1` plus `HANDOFF_BETA_USERS`). Everything
user-facing says "being built". The owner's brief (2026-11-24) is the source; this file records
what was built, the decisions, and the privacy story in plain words.

## How it works, in plain words (for the website's FAQ)

- **Nothing leaves your computer until you press Send.** When the timeline is on (Screen Coach
  settings → Handoff, off by default), neb keeps the moments you save and a note of the app in
  front (its page, and the git branch for code), **on your computer only, encrypted for your
  Windows account, for 24 hours**. Apps you've blocked and private windows are never kept.
- **You see everything first.** "Hand off…" shows a preview: the brief neb wrote, the moments
  with private things already hidden, and a count of what was hidden. You can edit the brief,
  drop moments, hide more by dragging a box, and hide every name.
- **Private by default.** Emails, phone numbers, card numbers, API keys and tokens, passwords,
  private keys, `.env` lines, addresses and secret parts of web addresses are removed from the
  text and covered in the pictures before the preview, on your computer.
- **Only the people you invite can open it.** The package is encrypted on your computer; we store
  only ciphertext. Its key is released only to the people you sent it to, after they sign in
  with the email you used. A link alone shows just "A handoff from Faraz".
- **You stay in charge.** You can see who opened it, revoke it at any time (the link stops
  working at once and the package is deleted), and it expires on its own (7 days by default).
- **The receiver stays in charge.** "Pick up from here" lists what it will do and asks before
  each step: it reopens the files and pages, offers to switch to the same git branch (stashing
  your changes first if you choose, never discarding them), and shows the next step. It never
  runs commands: those are shown with a Copy button.

## The data flow

```
sender desktop (Rust)                          server                         receiver
timeline (DPAPI, 24 h) ──► draft: key moments ─► POST /api/handoff/brief (1 question; text + ≤4 redacted crops)
  moments: crops covered with every rule        ◄── brief (schema-checked; retry once; fallback)
  snapshots: app, page, git (read-only)
preview (local page; mewhandoff:// crops) ──► Send: AES-256-GCM with a random key (CNG)
  POST /api/handoff (key wrapped with HANDOFF_KEY_SECRET) ─► FastAPI /v1/handoffs (service key)
  POST …/package (ciphertext) ─► Supabase Storage "handoffs" (private, ciphertext only)
  POST …/finalize                                                   ┌─► web viewer /h/<id> (signed in)
                                                                    │   GET /api/handoff/<id>: key, after membership check
                                                                    │   ciphertext → decrypted in the browser (WebCrypto)
                                                                    │   walkthrough (cached per language, single-flight)
                                                                    │   ask (1 question; "not covered" costs nothing)
                                                                    └─► desktop: Pick up from here (decrypted in Rust)
```

## What was built

| Piece                                                                      | Where                                                                                                          |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Schemas, redaction, prompts, script markers                                | `packages/shared/src/handoff.ts`, `handoff-redaction.cases.json` (shared by the TS and Rust tests)             |
| Storage, membership, 403/410, purge, inbox, replies, history               | `backend/src/mew_api/handoffs/`, `routes/handoffs.py`, migration `20261124000000_handoffs.sql`                 |
| Server routes, key wrapping, brief/walkthrough/ask                         | `frontend/src/server/handoff.ts`, `app/api/handoff/**`, `app/api/handoffs/**`                                  |
| Web viewer and inbox                                                       | `frontend/src/features/handoff/`, `/h/<id>`, `/handoffs`                                                       |
| Desktop: timeline, snapshots, redaction, package, crypto, preview, Pick up | `desktop/src-tauri/src/screen/handoff/`, `handoff_run.rs`, `win/handoff_*.rs`, `win/git.rs`, `shell/handoff.*` |
| Daily purge                                                                | `GET /api/handoffs/purge` (Vercel cron, `frontend/vercel.json`)                                                |

## Decisions (made 2026-11-24 because the owner said "build it, test it, push it"; binding until the owner changes them)

1. **Teams:** no team tables yet. The recipient picker suggests people you've handed off to;
   anyone else gets "isn't someone you've handed off to before. Send anyway?" (brief Q1 open).
2. **Receivers must sign in** to see anything beyond "A handoff from <first name>" (brief Q2).
3. **Default expiry 7 days** (brief Q3).
4. **Free during beta**, with the brief's quota rules: creating costs 1 question (the brief);
   opening and the walkthrough are free; each answered question costs 1, "not covered" is free.
5. **No email notifications yet**: the recipient sees it in the inbox. Email needs a mail
   service in the web app (Resend is only on the website), which the working agreement says to
   ask about first.
6. **No Ctrl+Alt+H hotkey**: NOTEBOOKS_K decision K2 (one global gesture, no other hotkeys) is
   binding. Hand off is in the tray menu and by voice ("hand this off to Rahbir").
7. **Server-held wrapping key** (`HANDOFF_KEY_SECRET`) stands in for a KMS. The server can open a
   package (it needs to, for the walkthrough and Q&A); storage only ever holds ciphertext.
8. **Crops are JPEG**, not WebP (Windows has a JPEG encoder built in; no new crate).
9. **The package is read through the API** (members only), not with a 5-minute signed URL: same
   effect, and it works in local mode and with the strict CSP.
10. **Prompts live in TypeScript** (`packages/shared/src/handoff.ts`) like every other prompt in
    the repo, not in `.md` files, so the server imports them directly.
11. **Detected secrets can't be un-hidden** in the preview at all (stricter than "confirm to
    include"). Names are flagged, not hidden, with "Hide all names".
12. **Terminal history and UI Automation selections** (sheet, cell range, slide) aren't read yet:
    snapshots carry the app, title, document, page URL, a path seen in the title or prompt, and git.

## Tests (all run locally on Windows)

- Redaction: the 16 shared cases and 6 clean texts pass in TypeScript and Rust; the package test
  asserts no secret survives into the plaintext; the backend log test asserts no content is logged.
- Membership, revoke (410 on the next request, the object deleted at once), expiry, purge, drafts,
  inbox, replies, history: `backend/tests/test_handoffs.py`; RLS and constraints:
  `backend/supabase/tests/handoffs.test.ts`.
- Crypto: AES-GCM round trips in Rust (CNG), Node and WebCrypto; Rust opens a Node-sealed vector.
- Grounding: 10 out-of-package questions all answer "didn't cover that"; citations are filtered.
- Cost/load: 50 concurrent first opens make one walkthrough (Redis single-flight); later opens hit
  the cache.
- Pick up safety: the git step test lists every command it can produce (status, rev-parse,
  `stash push`, `switch`, `pull --ff-only`); uncommitted changes need stash or nothing happens.

## Not built yet

Model evals with 10 fixture sessions (the property checks exist as unit tests with fake models);
the walkthrough's voice speed (1.5×/2× changes caption and replay pacing, not the voice);
email notifications; teams; the desktop "Inbox" view (the web inbox works inside the app).

## Manual checklist (a real Windows laptop, signed in, `HANDOFF_ENABLED=1`)

1. Screen Coach settings → Handoff → turn on the timeline. Circle and ask about 3–4 things
   (one showing an error). Switch apps. The timeline list shows moments and snapshots.
2. Tray → Hand off… The preview appears within ~6 s, with a brief and the moments; an email in
   a crop is covered; the badge counts what was hidden. Drag a box on a picture; untick a moment.
3. Send to a second account's email. Sign in as them at `/h/<id>`: play the walkthrough, ask a
   question it covers (cites a moment) and one it doesn't ("didn't cover that"), reply.
4. As a third account, open the link: "This handoff wasn't shared with you".
5. In the desktop app as the receiver: Pick up from here → each step asks; with uncommitted
   changes, git offers stash or cancel; a command step only copies.
6. As the sender, revoke: the receiver's next request shows it was revoked.
