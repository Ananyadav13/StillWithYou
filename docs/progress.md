# StillWithYou — development progress

Living record of what is built, what is verified, and what is blocked. Update this
at the end of every step. If you are picking this project up in a fresh session,
read this file first, then `docs/phase2-slo.md` and `docs/phase2-runbook.md`.

**Last updated:** 2026-07-28

---

## Current state at a glance

| Phase | Status |
|-------|--------|
| Phase 1 — chat skeleton | ✅ Done (`253aa77`, `6b65866`) |
| Phase 1 backfill — persistence + Gemini | ✅ Done (`8f23409`) |
| Phase 2 — resilience layer | ✅ Steps 0–10 done, deferred item now closed |
| Phase 3 — multilingual (en / hi / hi-en-mixed) | ✅ Steps 0–11 done, one known limitation |

**Everything runs.** Postgres, Redis and Prometheus are in compose; the API, the
ARQ worker and the frontend all start clean; **17 tests pass** (5 Phase 2
failure-injection, 6 cache-key, 6 Phase 3 regression).

**The Phase 2 deferred item is closed.** Step 3's DONE WHEN asked to see
`pending → complete` with a result sourced from Gemini. That was observed end-to-end
during Phase 3 Step 7 testing, once Gemini recovered — see below.

---

## The Gemini situation — RECOVERED as of 2026-07-28

**Gemini is answering again.** Verified directly with two live calls on 2026-07-28:

```
call 1: OK 2154ms  mood=angry tox=0.7 source=gemini
call 2: OK 2050ms  mood=warm  tox=0.0 source=gemini
```

### It is still switched off, deliberately

`settings.gemini_enabled` is `False`. Three reasons, none of them inertia:

1. **Phase 3 was specified to run free and self-hosted**, and that requirement does not
   expire because the paid dependency came back. The local path is the one that has
   been measured against a 45-message corpus.
2. **Latency.** Gemini answers in 2050–2154ms against `multilingual_local`'s 40ms
   median — roughly 50× slower, and at the edge of the 2s budget in `phase2-slo.md`.
3. **The recovery is unexplained.** The block was a project-level `403
   PERMISSION_DENIED`, not quota, and nobody contacted Google support. Something
   changed on their side without notice and could change back the same way.

Enabling it is `GEMINI_ENABLED=true` — a config flip, not a code change, which is what
Step 7 was built to guarantee. **The decision to flip it has not been made**; it needs
a judgement about the latency trade, and about whether accuracy that has never been
measured on this corpus should displace accuracy that has.

### The previous failure, for the record

All three keys were unusable on 2026-07-27:

| key (sha256 prefix) | behaviour |
|---|---|
| `d8bc94a4` | hangs past 25s on every call |
| `e3f271d2` | hangs past 25s on every call |
| `7f2b0c65` | `403 PERMISSION_DENIED — "Your project has been denied access. Please contact support."` |

This was **project-level, not quota**, so key rotation could not have fixed it.

Worth remembering that the system stayed fully functional throughout: every message
still reached `complete` via the local path. That is the whole point of Phase 2, and it
was demonstrated by an unplanned real outage rather than an injected one.

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

---

## Phase 3 — multilingual mood/toxicity (en / hi / hi-en-mixed)

Full detail in [`docs/phase3-results.md`](phase3-results.md); scope and non-goals in
[`docs/phase3-scope.md`](phase3-scope.md).

### Model chosen, and why

**`cardiffnlp/twitter-xlm-roberta-base-sentiment`** — XLM-RoBERTa-base, 278M params,
3-class sentiment fine-tuned on ~198M tweets across 8 languages including Hindi.

The deciding evidence was at the tokenizer, checked before any integration: Devanagari
tokenizes at word level with **zero UNK tokens**, and romanized Hindi resolves to real
vocabulary entries (`▁tum`, `▁meri`, `▁baat`, `▁kar`) — meaning Hinglish is in
XLM-R's pretraining distribution rather than byte-fallback noise. Twitter fine-tuning
matches the domain: short, informal, code-switched.

Rejected: `tabularisai/multilingual-sentiment-analysis` (cc-by-**nc**-4.0, would
permanently restrict commercial use); `pascalrai/hinglish-twitter-roberta-base-sentiment`
(built on English `roberta-base` — **no Devanagari coverage at all**);
`textdetox/xlmr-large-toxicity-classifier` (binary toxic/neutral, cannot express a
4-level mood scale).

### Measured, on CPU

| Metric | Value |
|---|---|
| Disk size | 1117.3 MB |
| Cold load, fresh process | 8.22s (7078ms in the worker) |
| First inference | 469.6ms (one-off warm-up; `warm()` at worker startup) |
| Inference, n=20 | **median 40.0ms**, p95 49.4ms |
| End-to-end, POST → `complete` | 422–636ms |

No ONNX conversion — measured first. 40ms against Gemini's 2050ms is ~50× faster; a
build step and a second copy of the weights to save tens of milliseconds inside an
already-async job is not worth it.

### Final accuracy, 45 hand-written fixtures

| language | 4-way mood | lexicon disabled | polarity (model only) |
|---|---|---|---|
| `en` | 11/15 | 11/15 | 14/15 |
| `hi` | 10/15 | 10/15 | 14/15 |
| `hi-en-mixed` | 11/15 | 9/15 | 13/15 |
| **total** | **32/45 (71%)** | 30/45 | **41/45 (91%)** |

Language detection: **45/45**, plus **6/6 on held-out real messages** not used to build
the detector. `langdetect` alone scores 30/45 and **0/15 on Hinglish** — it never once
returns `hi` for romanized Hindi.

### Known limitation: `angry` 6/15

The weak category is not a language — per-language accuracy is flat. It is `angry`, and
it fails the same way in all three. **A polarity model cannot see cold contempt.**
Withdrawal and cold refusal ("Forget it. I'm done asking you for anything",
`छोड़ो। अब तुमसे कुछ माँगना ही नहीं है मुझे`) are not linguistically negative and never
reach the `p_neg >= 0.80` promotion threshold.

Step 5 tested one bounded fix with the criterion fixed in advance: adding an independent
toxicity classifier had to recover ≥5 of the 9 missed `angry` fixtures. **It recovered
0.** Seven of the nine scored `p_toxic ≤ 0.069`; the highest-scoring calm message
(`hinglish-01`, a friend told to go and rest) scored **0.542 — more toxic than all nine
genuinely angry messages**. Both models are proxies for *loud* negativity. Reverted, not
integrated; documented rather than forced.

### Fully free, zero Gemini dependency

Everything above runs on a locally-hosted open-weight model. No paid API, no billing
account, no credit card, no network call at inference time. `analysis_source` is
`multilingual_local` and never claims to be Gemini. Gemini remains wired as the nominal
primary behind the circuit breaker, gated by `GEMINI_ENABLED` (currently `false`).

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

**`analysis_source` was `varchar(16)`; `multilingual_local` is 18 characters.** Every
Phase 3 write died with `StringDataRightTruncationError`, surfacing as an ARQ job crash
that left rows in `pending`. Widened to 32 in migration `c7d1a4f92b30`. Only the tests
that hit real Postgres caught it — the fixture scripts never touch the database.

**A stale ARQ worker from an earlier session will silently steal jobs.** Phase 3 Step 7
end-to-end results came back `source=gemini` despite `gemini_enabled=False`, because a
worker started hours earlier was still consuming the same Redis queue with pre-Phase-3
code. Check for orphaned `python -m arq` processes before trusting any end-to-end run.

**Then the cache will keep serving those wrong results.** After killing the stale
worker, results were *still* `source=gemini` — cache hits, given away by 215–426ms
completions against a real path that takes ~630ms. `cache.clear()` before any
end-to-end measurement.

**The Windows console is cp1252 and cannot print Devanagari.** Any script that prints
Hindi dies with `UnicodeEncodeError` before showing a single result. Set
`PYTHONIOENCODING=utf-8` or `sys.stdout.reconfigure(encoding="utf-8")`.

**Hugging Face downloads need `HF_HUB_DISABLE_SYMLINKS=1` on Windows.** Without
Developer Mode the cache cannot create symlinks and the download dies mid-file with
`WinError 1314`. Downloads also stall silently on this connection — `scripts/fetch_model.py`
retries and resumes from the partial blob rather than restarting.

**Nirmala UI ships as `Nirmala.ttc`, not `.ttf`.** And Segoe UI carries 10 stray
Devanagari codepoints, enough to make a naive "first font with any Devanagari" check
pick a face that renders nothing legible. Resolve against the actual string.

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
