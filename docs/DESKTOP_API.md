# Desktop API contract

The single source both sides are built against: the desktop app (`mew/desktop`) and the Next.js
app (`mew/frontend`, at `NEB_APP_URL`: `https://app.myneb.si` in production, a staging URL for
testing). An identical copy lives in `neb_web/docs/DESKTOP_API.md`. Change both together.

## Headers on every desktop request

| Header                           | What                                                                                                                  |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `Authorization: Bearer mewdt_…`  | The device token (43 url-safe characters after `mewdt_`). Kept in Windows Credential Manager.                         |
| `X-Neb-Device: <uuid v4>`        | This computer's own id, made once and kept in Credential Manager (survives reinstalling). The server stores its hash. |
| `Content-Type: application/json` | POST bodies.                                                                                                          |
| `Accept: application/x-ndjson`   | Streaming answers (one JSON event per line).                                                                          |

## Signing in

1. **Start (app).** A PKCE verifier and a random `state` stay in the app. It opens
   `/desktop/authorize?challenge=<base64url(sha256(verifier))>&state=<state>&device=windows&at=<unix s>`.
2. **Browser.** No account: Clerk sign-up first ("Already have an account? Sign in"), then back.
   Signed in: "Connect neb on a Windows PC, started just now?" with **Continue** (always a click),
   **This wasn't me** (`POST /api/devices/link/cancel {challenge}`: the sign-in can't finish) and
   "Use a different account".
3. **Continue** → `POST /api/devices/link {challenge}` → a code (60 s, single use, bound to the
   challenge) → `neb://auth/callback?code=…&state=…`. The app ignores a link whose `state` isn't
   its own.
4. **Exchange (app).** `POST /api/devices/sign-in {code, verifier, deviceName}` → `{token, ticket}`
   (device token until revoked; Clerk ticket 60 s). 10 per 10 minutes per address.
5. **Polling fallback (app).** Every 2 s for up to 3 minutes:
   `POST /api/devices/poll {verifier, deviceName}` → 202 waiting, 410 cancelled, or 200 with the same
   `{token, ticket}`. Whichever of link or poll arrives first wins.
6. **Last fallback:** "Copy the link" on the app's sign-in screen.
7. **Sign out:** `POST /api/devices/revoke-self` (the app), or Settings → Signed-in devices (web).
   Every request checks the token, so it stops at once.

## Asking

| Route                                                     | Counts as                                                           |
| --------------------------------------------------------- | ------------------------------------------------------------------- |
| `POST /api/screen/ask`                                    | 1 question (with `walkthroughId`: a step of that walkthrough, free) |
| `POST /api/screen/circle-ask`                             | 1 question per `sessionId`; up to 8 follow-ups in it are free       |
| `POST /api/screen/coach/start`, `/resume`, `/recheck`     | 1 question; the walkthrough's `/step` calls are free (up to 40)     |
| `GET /api/screen/quota`                                   | `{enforced, used, limit, remaining, unlimited}`                     |
| Other `/api/screen/*` model calls (quiz, reanchor, notes) | Not a question, but refused once none are left                      |

Answers say `X-Neb-Questions-Left: <n>` when questions are counted. A question is refunded when
nothing reached the learner (a model failure or a dropped connection). Follow-up groups last 30
minutes after their last call.

## Refusals

Every refusal is `{"error": "<a sentence to show the learner>", "code": "<CODE>"}`. The app shows
`error` as is for these codes, and its own words for anything else.

| Status | `code`             | When                                                                                                                          | Extra header  |
| ------ | ------------------ | ----------------------------------------------------------------------------------------------------------------------------- | ------------- |
| 401    | (none)             | No token, an unknown or revoked one, another Clerk instance                                                                   |               |
| 403    | `EMAIL_UNVERIFIED` | The account's primary email isn't verified                                                                                    |               |
| 429    | `RATE_LIMITED`     | 3 asks a minute or 15 an hour per account, 10 a minute per address                                                            | `Retry-After` |
| 429    | `QUOTA_EXCEEDED`   | The account's or this computer's free questions are used ("…we'll email you at a•••@gmail.com…"), or a follow-up past its cap |               |
| 503    | `AT_CAPACITY`      | Today's global cap, or `NEB_ASK_ENABLED=false`                                                                                |               |
