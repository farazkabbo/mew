# Mew API (FastAPI)

The internal service behind the web app: maths checking (SymPy), course ingestion (PDF →
passages → embeddings → concept graph), lessons and retrieval. Python 3.12, managed with
[uv](https://docs.astral.sh/uv/). Overall architecture and decisions:
[docs/HANDOFF.md](../docs/HANDOFF.md).

**Browsers never call this service.** Only the Next.js server does, with the shared
`X-Internal-Secret` plus the user's Clerk session token. It sends no CORS headers, rejects
unknown `Host` headers, and hides `/docs` outside development.

## Run

```sh
uv sync                     # once (or after pulling dependency changes)
pnpm dev                    # from the repo root: web :3000 + API :8000
uv run --frozen uvicorn --factory mew_api.main:create_app --reload --port 8000   # API alone
```

Configuration comes from the repo-root `.env.local` (see `.env.example`), validated by
`src/mew_api/config.py`. In development `/docs` shows the OpenAPI UI.

## Check

```sh
uv run --frozen pytest      # 83 tests (auth, checker + sandbox, courses, config, health)
uv run --frozen ruff check . && uv run --frozen ruff format --check .
uv run --frozen mypy        # strict
pnpm --filter @mew/backend audit:py   # pip-audit of runtime dependencies
```

Database migrations and their RLS tests live in `supabase/` (TypeScript, PGlite + pgvector;
`pnpm --filter @mew/db test`).

## Endpoints

| Method and path                                        | Caller      | What it does                                              |
| ------------------------------------------------------ | ----------- | --------------------------------------------------------- |
| `GET /health`                                          | public      | Liveness and version                                      |
| `GET /v1/me`                                           | Clerk user  | Echoes the verified user id (the web `/status` page)      |
| `POST /v1/check/math`                                  | internal    | Is each LaTeX line a correct step from the previous one?  |
| `POST /v1/courses?title=…` (body: `application/pdf`)   | user        | Creates a course and starts building it (202)             |
| `GET /v1/courses`, `GET /v1/courses/{id}`              | user        | List; detail with sources, concepts and prerequisites     |
| `PATCH /v1/courses/{id}`                               | user        | Title, exam date, or confirm the scope review (`ready`)   |
| `DELETE /v1/courses/{id}`                              | user        | Deletes the course, its rows and its stored PDF           |
| `POST /v1/courses/{id}/review`                         | user        | Scope review: merges, removals, order, renames            |
| `POST /v1/courses/{id}/retrieve`                       | user        | Most relevant passages (with pages) for a question        |
| `GET /v1/courses/{id}/concepts/{concept_id}/lesson`    | user        | Lesson for a concept (generated once, then cached)        |
| `GET /v1/courses/{id}/learner`                         | user        | The course's attempts (oldest first) and review cards     |
| `POST /v1/courses/{id}/attempts`                       | user        | Logs an answer and saves the concept's rescheduled card   |
| `POST /v1/courses/{id}/explored`                       | user        | Starts a concept's review card (once), when it's opened   |
| `GET /v1/learner/due?limit=`                           | user        | Concepts due for review, across the caller's courses      |

The learner endpoints (M8) store what the web server computes: FSRS runs there (ts-fsrs), and
each attempt arrives with the concept's updated card, validated here (`learner/models.py`).

Everything under `/v1` needs `X-Internal-Secret`. "User" endpoints take the caller from
`deps.current_caller`: a Clerk token verified against Clerk's JWKS (issuer, expiry, `azp`,
RS256), or, **only when `APP_ENV=development`**, the local-mode marker `X-Mew-Local-User: local`
that the web app sends when it runs without Clerk.

## How it's built

```
src/mew_api/
  main.py            app factory: middleware, routers, sandbox pools, local course store
  config.py          settings (Pydantic); production refuses to start without Clerk settings
  auth.py, deps.py   Clerk JWT verification; internal-secret check; Caller (user or local)
  checker/
    latex.py         LaTeX → SymPy with the strict Lark parser (no eval); size/power guards
    steps.py         step checking: equivalence, implication, solution sets, units (SI)
    sandbox.py       process pools with hard timeouts (stuck workers are killed) and a
                     memory cap on Linux; used for SymPy and for PDF parsing
  courses/
    pdf.py           pdfium (pypdfium2): text per page; renders near-empty pages for OCR
    chunking.py      page-exact passages under their nearest heading
    embeddings.py    Gemini embeddings (768-d), or a lexical fallback without a key
    llm.py           structured Gemini calls (Interactions API, store=False, schema rules)
    prompts.py       versioned prompts: concept graph, lesson, OCR
    concepts.py      concept graph (model, cleaned) or heading-based fallback
    lessons.py       lessons (model) or summary + source passage fallback
    store.py         CourseStore protocol + in-memory store (local mode)
    supabase_store.py  PostgREST + Storage with the user's token, or the secret key (jobs)
    ingest.py        the ingestion job (status: processing → review | failed)
  routes/            health, me, check, courses
```

### Course storage

- **Signed-in users:** Supabase. Requests use the publishable key plus the user's Clerk token,
  so RLS applies. Ingestion runs after the response and outlives that token, so the job writes
  with `SUPABASE_SECRET_KEY`, for the course the route just created for the verified caller,
  setting and filtering `user_id` on every row.
- **Local mode (development):** `MemoryCourseStore`, per user, lost when the API restarts.

### Gemini schema rules

Structured output schemas are generated from Pydantic models and pruned in `llm.py`. Two
rules come from testing against the real API: no `minItems`/`maxItems` (nested or combined
with unions they cause 400 "invalid argument"), and fields the model must fill have no default
(otherwise it skips them). Over-long text and lists are trimmed by validators
(`models.clipped`, `models.first`) rather than rejected. The TypeScript wrapper
(`frontend/src/server/gemini.ts`) follows the same rules.

## Deploy

`Dockerfile` builds a non-root image; `render.yaml` (repo root) deploys it to Render with a
`/health` check. Set `INTERNAL_API_SECRET`, `CLERK_ISSUER`, `CLERK_AUTHORIZED_PARTIES`,
`GEMINI_API_KEY`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` and
`SUPABASE_SECRET_KEY`. Use an instance with at least 2 GB of RAM: the SymPy workers and the
PDF worker each run in their own process.
