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

| Step | Call                                                                                                    | Lifetime                                         |
| ---- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| 1    | The app opens `/desktop/authorize?challenge=<base64url(sha256(verifier))>` in the browser (PKCE).       | The sign-in waits 10 minutes.                    |
| 2    | The signed-in page (one click) gets a link code: `POST /api/devices/link`.                              | Link code: 60 s, single use, bound to challenge. |
| 3    | Back to the app: `neb://auth/callback?code=…` (or "Copy the link" and paste it into the app).           |                                                  |
| 4    | `POST /api/devices/sign-in {code, verifier}` → `{token, ticket}`.                                       | Device token: until revoked. Clerk ticket: 60 s. |
| 5    | Sign out of this computer: `POST /api/devices/revoke-self`. From the web: Settings → Signed-in devices. | Revoking works at once (checked every request).  |

A device token is checked against the database on every request (no cache), so signing out
from the web, or Clerk deleting the account (`user.deleted` webhook), stops it immediately.

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

| Status | `code`             | When                                                               | Extra header  |
| ------ | ------------------ | ------------------------------------------------------------------ | ------------- |
| 401    | (none)             | No token, an unknown or revoked one, another Clerk instance        |               |
| 403    | `EMAIL_UNVERIFIED` | The account's primary email isn't verified                         |               |
| 429    | `RATE_LIMITED`     | 3 asks a minute or 15 an hour per account, 10 a minute per address | `Retry-After` |
| 429    | `QUOTA_EXCEEDED`   | The account's or this computer's free questions are used           |               |
| 503    | `AT_CAPACITY`      | Today's global cap, or `NEB_ASK_ENABLED=false`                     |               |
