# StillWithYou — development progress

Living record of what is built, what is verified, and what is blocked. Update this
at the end of every step. If you are picking this project up in a fresh session,
read this file first, then `docs/phase2-slo.md`.

**Last updated:** 2026-07-27

---

## Current state at a glance

| Phase | Status |
|-------|--------|
| Phase 1 — chat skeleton | ✅ Done and committed (`253aa77`, `6b65866`) |
| Phase 1 backfill — persistence + Gemini | 🟡 Code written, **not yet verified** (needs Postgres) |
| Phase 2 — resilience layer | 🟡 Step 0 done; Steps 1-10 pending |

**Active blocker:** Docker daemon is not running, so Postgres (and later Redis and
Prometheus) cannot start. Everything requiring a running service is unverified.
Start Docker Desktop, then `docker compose up -d`.

---

## Phase 1 — chat skeleton ✅

React + TypeScript chat UI, FastAPI `/ping` and `/health`, CORS, project structure.
Committed. No database, no AI.

## Phase 1 backfill — persistence + Gemini 🟡

Phase 2 was specified as "the resilience layer around the Gemini integration built
in Phase 1", but that integration did not exist in the repo — no `analyze_message()`,
no messages table, no Alembic, no `POST /messages`. This backfill supplies exactly
the Phase 1 surface Phase 2 needs to wrap, including the *synchronous* Gemini call
that Phase 2 Step 3 later moves into a job.

| Item | File | Verified |
|------|------|----------|
| Async SQLAlchemy engine + session dep | `backend/app/core/db.py` | ❌ needs Postgres |
| `messages` table model | `backend/app/models/message.py` | ❌ |
| Alembic (async env) | `backend/alembic/`, `backend/alembic.ini` | ❌ no migration generated yet |
| `AnalysisResult` shared shape | `backend/app/schemas/analysis.py` | ✅ imports clean |
| `analyze_message()` | `backend/app/services/gemini.py` | ✅ real API calls succeed |
| `POST /messages` | `backend/app/routers/chat.py` | ❌ needs Postgres |
| Postgres service | `docker-compose.yml` | ❌ needs Docker |

## Phase 2 — resilience layer

| Step | Description | Status |
|------|-------------|--------|
| 0 | Reliability target — `docs/phase2-slo.md` | ✅ Done, with measured baseline |
| 1 | Structured JSON logging + instrument `analyze_message()` | ⬜ Pending |
| 2 | Redis + ARQ setup | ⬜ Blocked on Docker |
| 3 | Move analysis to async ARQ job + polling endpoint | ⬜ Blocked |
| 4 | Debounce at source (frontend, send-only trigger) | ⬜ Pending |
| 5 | Circuit breaker (Redis-backed) | ⬜ Blocked |
| 6 | Local fallback analyzer | ⬜ Pending |
| 7 | Cache / dedup | ⬜ Blocked |
| 8 | Prometheus `/metrics` | ⬜ Blocked |
| 9 | Runbook | ⬜ Pending |
| 10 | Failure injection test | ⬜ Blocked |

---

## Decisions and gotchas discovered the hard way

Things that cost real debugging time. Do not re-derive these.

**Gemini model choice is forced, not preferred.** On the current API key,
`gemini-2.0-flash`, `gemini-2.0-flash-lite` and `gemini-2.5-pro` all return
`429 RESOURCE_EXHAUSTED` with `limit: 0` — the key has no quota for them at all, so
no amount of retrying helps. `gemini-2.5-flash` and `gemini-2.5-flash-lite` return
404 "no longer available". `gemini-3.5-flash-lite` is the fastest model that
actually answers. If analysis suddenly 429s everywhere, check the model name
before suspecting the code.

**`thinking_level="low"` is required to meet the SLO.** With the default thinking
level the analysis prompt took 6.0-12.6s and timed out once at 30s — 0/5 calls
under the 2s budget. With `thinking_level="low"` the same five prompts ran at a
1410ms median, 5/5 under 2s. This is set in `gemini.py`; do not remove it.

**The 3s deadline must be enforced client-side.** Passing
`http_options.timeout=3000` makes the API reject the request outright:
`"Manually set deadline 3s is too short. Minimum allowed deadline is 10s."` The
timeout is therefore an `asyncio.wait_for` wrapper in `analyze_message()`. 3s is
our budget, not something the remote side will agree to.

**Gemini latency variance is large.** Identical model and config produced a 1.3s
median in one run and a 9.6s median with a 30s timeout in another. Any design that
puts this call in the request path will breach the SLO eventually. This is the
core justification for Phase 2's async-job architecture.

**First Gemini call in a fresh process can block the event loop.** One observed
cold start took 592s wall-clock before `asyncio.wait_for` could fire, because
client construction runs synchronously inside the coroutine. Warm the client
(`get_client()`) at startup rather than on the first request.

---

## Conventions

- Commits: `Phase 2, Step N: <description>`, authored by Ananya, no AI attribution.
- Every step needs pasted real command output before it counts as done. If the
  evidence cannot be produced, the step is not done — say so rather than proceeding.
- Secrets live in `backend/.env` (gitignored). `backend/.env.example` documents the
  keys with empty values.

## Running it

```bash
docker compose up -d                   # postgres (+ redis, prometheus from Step 2/8)
cd backend
.venv/Scripts/python.exe -m alembic upgrade head
.venv/Scripts/python.exe -m uvicorn app.main:app --reload --port 8000
```
