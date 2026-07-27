# StillWithYou — development progress

Living record of what is built, what is verified, and what is blocked. Update this
at the end of every step. If you are picking this project up in a fresh session,
read this file first, then `docs/phase2-slo.md` and `docs/phase2-runbook.md`.

**Last updated:** 2026-07-27

---

## Current state at a glance

| Phase | Status |
|-------|--------|
| Phase 1 — chat skeleton | ✅ Done (`253aa77`, `6b65866`) |
| Phase 1 backfill — persistence + Gemini | ✅ Done (`8f23409`) |
| Phase 2 — resilience layer | ✅ Steps 0–10 done, one evidence item deferred |

**Everything runs.** Postgres, Redis and Prometheus are in compose; the API, the
ARQ worker and the frontend all start clean; 5 failure-injection tests pass.

**One deferred item:** Step 3's DONE WHEN asked to see `pending → complete` with a
result from Gemini. Gemini went down mid-build and never recovered during the
session, so that transition has only been observed resolving via the local
fallback. Everything else in Step 3 is verified. Re-run
`verify_step3.py` once the API recovers to close it out.

---

## The Gemini situation (read this before debugging anything)

All three configured keys are unusable as of 2026-07-27:

| key (sha256 prefix) | behaviour |
|---|---|
| `d8bc94a4` | hangs past 25s on every call |
| `e3f271d2` | hangs past 25s on every call |
| `7f2b0c65` | `403 PERMISSION_DENIED — "Your project has been denied access. Please contact support."` |

This is **project-level, not quota**, so key rotation cannot fix it — that third
key needs Google support. Earlier in the same session the first key was answering
in 1.0–1.8s, so this is a change on Google's side, not in our code.

The system is fully functional in this state: every message still gets analysed by
the local fallback and reaches `complete`. That is the whole point of Phase 2.

---

## Phase 2 — what each step delivered

| Step | Delivered | Key evidence |
|------|-----------|--------------|
| 0 | `docs/phase2-slo.md` | SLI/SLO + 4 failure modes, with a measured baseline |
| 1 | `core/logging.py`, JSON logs | 5 sends → 5 structured lines with real latencies |
| 2 | Redis + ARQ worker | worker connects, `ping_job` round-trips |
| 3 | ARQ job + polling endpoint | POST 27–42ms while Gemini hung >45s |
| 4 | send-only trigger + rationale | 0 backend requests in a 20s typing window, 1 on send |
| 5 | `services/circuit_breaker.py` | trips after 3 failures; 3008ms → 3.87ms when OPEN |
| 6 | `services/local_fallback.py` | `complete` in 267ms with circuit OPEN |
| 7 | `services/cache.py` | `cache_miss` then `cache_hit` on the same key |
| 8 | `/metrics` + prometheus | 6 metric families non-zero; scrape target healthy |
| 9 | `docs/phase2-runbook.md` | OPEN circuit, zero cache hits, stuck pending, overshoot |
| 10 | `tests/test_failure_injection.py` | 5 passed in 2.42s |

## Measured numbers (all real, from this session)

| Metric | Value |
|--------|-------|
| POST /messages, server-side | 27–42ms (median 41.1ms over 24 sends, p95 85.8ms) |
| Gemini analysis, healthy | median 1410ms, 5/5 under 2s (`thinking_level="low"`) |
| Gemini analysis, default thinking | 6.0–12.6s, 0/5 under 2s, one 30s timeout |
| Local fallback compute | **median 0.014ms**, p95 0.026ms (n=1000) |
| Cache hit (Redis GET) | median 1.085ms, p95 1.697ms (n=200) |
| Circuit OPEN short-circuit | 3.87–6.72ms vs 3008–3014ms CLOSED |
| Cache hit rate, realistic traffic | **37.5%** (9 hits / 24 sends, 12 unique) |

---

## Decisions and gotchas discovered the hard way

Things that cost real debugging time. Do not re-derive these.

**Gemini model choice is forced.** `gemini-2.0-flash`, `gemini-2.0-flash-lite` and
`gemini-2.5-pro` all return `429` with `limit: 0` on these keys — no quota at all,
so retrying never helps. `gemini-2.5-flash`/`-lite` return 404 "no longer
available". `gemini-3.5-flash-lite` is the fastest that answers.

**`thinking_level="low"` is required to meet the SLO.** Default thinking took
6.0–12.6s and timed out once at 30s (0/5 under 2s). With `low`, the same prompts
ran at a 1410ms median, 5/5 under 2s. Set in `gemini.py`; do not remove it.

**The 3s deadline must be enforced client-side.** `http_options.timeout=3000` makes
the API reject the request: *"Manually set deadline 3s is too short. Minimum
allowed deadline is 10s."* Hence the `asyncio.wait_for` wrapper.

**Gemini latency variance is enormous.** Identical config gave a 1.3s median in one
run and a 9.6s median with a 30s timeout in another. This is the core justification
for the async-job architecture.

**First Gemini call in a fresh process can block the event loop.** One cold start
took 592s wall-clock before `wait_for` could fire. Both the API and the worker now
warm the client at startup.

**Alembic + asyncpg does not emit `CREATE TYPE`.** `add_column` with an Enum fails
with *"type analysis_status does not exist"*. Create the enum explicitly, and drop
it in `downgrade` or the next upgrade fails with "already exists".

**`localhost` costs ~2s per request from Python on Windows.** urllib resolves IPv6
first and pays the fallback. Use `127.0.0.1` in test scripts — this masqueraded as
a 2s API regression until it was isolated with curl's `time_connect`.

**pytest-asyncio needs a session-scoped loop here.** The engine, asyncpg pool and
Redis client are process-wide singletons; a loop per test closes them underneath
the next one.

**ARQ runs jobs concurrently (`max_jobs`, default 10).** A burst of 7 duplicate
sends produced 7 Gemini calls and 0 cache hits — all jobs called `allow()` and read
the cache before the first result was written. The breaker is trip-after-N, not
admit-only-N. See the runbook for mitigations.

**The cache is slower than the fallback.** A Redis GET is ~1.085ms; recomputing the
lexicon score is ~0.014ms. The cache only pays for itself against Gemini. A
worthwhile future optimisation: skip the cache lookup entirely while the circuit
is OPEN.

---

## Known gaps / next candidates

- Step 3's Gemini-sourced `complete` transition, pending API recovery.
- Cache lookup is wasted work while the circuit is OPEN (see above).
- No single-flight: duplicate concurrent sends each do full work.
- The frontend receives `analysis_source`, `mood` and scores but does not render
  them — deliberately out of scope, UI is a later phase.
- Grafana was skipped as optional.

## Conventions

- Commits: `Phase 2, Step N: <description>`, authored by Ananya, no AI attribution.
- Every step needs pasted real output before it counts as done.
- Secrets live in `backend/.env` (gitignored); `.env.example` documents the keys.

## Running it

```bash
docker compose up -d                      # postgres, redis, prometheus
cd backend
.venv/Scripts/python.exe -m alembic upgrade head
.venv/Scripts/python.exe -m uvicorn app.main:app --reload --port 8000   # terminal 1
.venv/Scripts/python.exe -m arq app.worker.WorkerSettings               # terminal 2
.venv/Scripts/python.exe -m pytest                                      # tests
```
