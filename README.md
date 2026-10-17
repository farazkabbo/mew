# mew

An ambient AI tutor that lives inside your notebook. It stays quiet until it's actually needed,
then answers by voice and in animated ink on the page.

## Repository layout

```
apps/web          Next.js 16 (App Router, TypeScript strict, Tailwind v4, Clerk auth)
services/api      FastAPI on Python 3.12 (internal service: checkers, ingestion, heavy LLM work)
packages/shared   Shared zod schemas and types (mirrored by Pydantic models in services/api)
packages/ink      Framework-free ink logic: geometry, spatial index, line segmentation, undo/redo
supabase          Postgres migrations (RLS) and their tests (run against PGlite, no Docker needed)
scripts           Dev tooling (`pnpm health`)
```

### How the pieces talk

```
browser ──(Clerk session cookie)──► Next.js server ──(X-Internal-Secret + Clerk JWT)──► FastAPI
   │                                     │
   └──(Clerk JWT, RLS-enforced)──────────┴──────────────────────────────────────────► Supabase
```

- **Clerk** owns identity. Supabase trusts Clerk tokens via
  [third-party auth](https://supabase.com/docs/guides/auth/third-party/clerk). The user id is the
  token's `sub` claim (`user_…`, a text column).
- **FastAPI is never called from the browser.** Only the Next.js server calls it, with a shared
  secret plus the user's Clerk token, which FastAPI verifies against Clerk's JWKS.
- **Supabase is reached with the user's own token**, so row-level security applies to every query.
  The secret key (which bypasses RLS) is reserved for narrowly scoped server jobs.

## Prerequisites

- Node.js ≥ 22 and pnpm 12 (`npm i -g pnpm`)
- [uv](https://docs.astral.sh/uv/) (installs Python 3.12 for the API automatically)

## Setup

```sh
pnpm install
cd services/api && uv sync && cd ../..
cp .env.example .env.local   # then fill it in (see below)
```

`.env.local` at the repo root is read by both the web app and the API. It is gitignored.

### Local mode (no Clerk keys)

Without `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, the dev server runs in **local mode**: no sign-in,
notebooks saved only in this browser, and the same strict CSP. Production refuses to serve
(HTTP 503) without Clerk keys, so local mode can't become an auth bypass.

### Clerk

1. Sign the CLI in to your Clerk account, link the app, and pull its dev keys into `apps/web/.env.local`:
   ```sh
   cd apps/web
   npx clerk@latest auth login
   npx clerk@latest link --app <your-app-id>
   npx clerk@latest env pull
   ```
   Or copy `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY` from the dashboard
   (API keys) into the root `.env.local`.
2. Set `CLERK_ISSUER` to your **Frontend API URL** (dashboard → API keys), e.g.
   `https://your-app.clerk.accounts.dev`.
3. Open [Connect with Supabase](https://dashboard.clerk.com/setup/supabase) in the Clerk dashboard.
   This adds the `role: authenticated` claim that Supabase needs.

### Supabase

1. In the Supabase dashboard: **Authentication → Third-party auth → Add Clerk**, using your Clerk
   domain.
2. Apply the migrations, either with the CLI:
   ```sh
   npx supabase@latest login
   npx supabase@latest link --project-ref <project-ref>
   npx supabase@latest db push
   ```
   or by pasting `supabase/migrations/*.sql` into the SQL editor, in filename order.
3. Put the project URL and the **publishable** key in `.env.local`. Never put the secret key in a
   `NEXT_PUBLIC_` variable; the app refuses to start if you do.

## Develop

```sh
pnpm dev       # web on :3000, API on :8000
pnpm health    # checks both services (and web → API connectivity)
```

When signed in, open [/status](http://localhost:3000/status). It runs end-to-end checks of the
auth chain (Clerk → FastAPI, Clerk → Supabase RLS) and says what to fix when one fails.

## The notebook

Open [/notebook](http://localhost:3000/notebook). Strokes are vectors stored locally in IndexedDB
(one database per user) and validated whenever they're read back.

| Action                     | How                                                                                     |
| -------------------------- | --------------------------------------------------------------------------------------- |
| Pen / highlighter / eraser | `P` / `H` / `E`, or the toolbar                                                         |
| Undo / redo                | `Ctrl+Z` / `Ctrl+Shift+Z` (or `Ctrl+Y`)                                                 |
| Zoom                       | `Ctrl`+wheel, trackpad pinch, two-finger pinch, `+` / `-`, `0` to reset                 |
| Pan                        | Wheel / two-finger scroll, `Space`+drag, middle mouse, or one finger once a pen is used |
| Show detected lines        | Toolbar (debug overlay for line segmentation)                                           |
| Export current line        | Toolbar → downloads the PNG crop that will be sent for recognition                      |

Pen pressure comes from the Pointer Events API (Apple Pencil, Wacom, Surface Pen). Mouse and
finger input get simulated pressure. Once a pen has been used, touches only navigate (basic palm
rejection).

## Quality gates

```sh
pnpm check                     # prettier, ESLint, tsc, vitest across the TS workspaces + API
pnpm --filter @mew/web e2e     # Playwright: drawing, persistence, eraser/undo, export, 60 fps
pnpm --filter @mew/api audit:py  # pip-audit of the API's runtime dependencies
pnpm audit --prod              # npm advisories
```

The database tests in `supabase/tests` apply every migration to an in-memory Postgres (PGlite)
that emulates Supabase's roles and `auth.jwt()`. They then attack the policies: cross-user reads
and writes, ownership spoofing, attaching rows to someone else's notebook, anon access, and
column-level tampering.

CI (`.github/workflows/ci.yml`) runs all of the above plus a production build and a gitleaks
secret scan. Actions are pinned to commit SHAs, and Dependabot keeps them and all dependencies
current.

## Deploy

- **API → Render.** `render.yaml` defines a Docker web service (`services/api/Dockerfile`,
  non-root, health check `/health`). Apply it as a Blueprint, then set `INTERNAL_API_SECRET`
  (same value as the web app), `CLERK_ISSUER` and `CLERK_AUTHORIZED_PARTIES` (your web origin).
  The service refuses to boot in production without them.
- **Web.** Set every variable from the Web section of `.env.example`, with `APP_ORIGIN` set to the
  public origin and `API_BASE_URL` set to the Render service URL.

## Security notes

- Strict, nonce-based Content-Security-Policy on every page (`src/proxy.ts`), plus HSTS,
  `X-Frame-Options: DENY`, `nosniff`, and a Permissions-Policy that allows the microphone only
  for this origin.
- Clerk `authorizedParties` is pinned to `APP_ORIGIN`. FastAPI checks `iss`, `exp`/`nbf`, `azp`,
  RS256 only, and throttles JWKS refetches.
- Env vars are validated with zod (web) and Pydantic (API). Errors name variables, never values.
- FastAPI hides `/docs` and the OpenAPI schema outside development, rejects unknown `Host`
  headers, and sends no CORS headers (browsers can't call it).
