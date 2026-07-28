# StillWithYou — development progress

Living record of what is built, what is verified, and what is blocked. Update this
at the end of every step. If you are picking this project up in a fresh session,
read this file first, then `docs/phase2-slo.md` and `docs/phase2-runbook.md`.

For a full standing introduction to the project rather than a change log — the problem,
the architecture, every measured number, and the known limitations — see
[`docs/project-overview.md`](project-overview.md). Every prompt in the project, product
and development, is in [`docs/prompts.md`](prompts.md).

**Last updated:** 2026-07-28

---

## Current state at a glance

| Phase | Status |
|-------|--------|
| Phase 1 — chat skeleton | ✅ Done (`253aa77`, `6b65866`) |
| Phase 1 backfill — persistence + Gemini | ✅ Done (`8f23409`) |
| Phase 2 — resilience layer | ✅ Steps 0–10 done, deferred item now closed |
| Phase 3 — multilingual (en / hi / hi-en-mixed) | ✅ Steps 0–11 done, one known limitation |
| Phase 4 — 2D mood avatar | ✅ Steps 0–7 done, presentation layer only, no backend change |

**Everything runs.** Postgres, Redis and Prometheus are in compose; the API, the
ARQ worker and the frontend all start clean; **21 tests pass** (5 Phase 2
failure-injection, 6 cache-key, 10 Phase 3 regression).

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

### Two blockers to fix BEFORE re-enabling it

Found while compiling [`docs/prompts.md`](prompts.md). Neither affects anything today,
because the prompt is dormant — both bite the moment `GEMINI_ENABLED=true`:

1. **The Gemini prompt says "two people in a close relationship."** The product serves
   any two people — friends, colleagues, housemates. The prompt primes for an intimacy
   baseline the product does not assume.
2. **The two analyzers use incompatible mood vocabularies.** Gemini returns an open set
   (`warm`, `hurt`, `playful`, `anxious`…); `multilingual_local` returns exactly
   `calm/neutral/frustrated/angry`. This was *observed*, not theorised — during Step 7
   testing a stale worker routed to Gemini and returned `warm` where the fixture expected
   `calm`. Re-enabling as-is would fail the Phase 3 regression test in a way that looks
   like a model regression rather than a vocabulary mismatch, and would put two label
   systems in one database column.

Fix: constrain `mood` with an `enum` in the response schema so the API enforces it.

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

### The regression test: per-category floors, not one aggregate

`tests/test_multilingual_regression.py` guards the accuracy above with **five separate
floors** rather than a single total. Each is measured−1, so one fixture flipping is
tolerated as noise while a real regression fails the build.

| category | measured | floor | margin |
|---|---|---|---|
| calm | 8/9 | 7/9 | +1 |
| neutral | 9/9 | 8/9 | +1 |
| frustrated | 9/12 | 8/12 | +1 |
| **angry** | 6/15 | **6/15** | **0 — hard floor, blocks a merge on any drop** |
| overall | 32/45 | 30/45 | +2 |
| language detection | 45/45 | 39/45 | +6 |

The overall floor is 30, deliberately: at 32 it would bind before any category floor
could fire (reinstating the zero-margin brittleness the redesign removed); at 29, the
exact sum of the floors, it could never fail independently. At 30 it catches **broad
shallow degradation** across several categories that no single floor would notice.

Each category is its own test function, not five asserts in one — with a single function
the first failure masks the rest, and naming the broken capability is the whole point.

**Verified by injection, not just by passing.** Forcing one `angry` fixture wrong dropped
that category to 5/15 and failed its assertion by name — while the **overall check passed
at 31/45**. An aggregate-only test would have shipped that regression silently.

**Caveat:** the floors assume `multilingual_samples.json` is unchanged. A failure
immediately after editing fixtures is a fixture change, not a code regression —
re-baseline rather than treating it as one. The test cannot distinguish the two.

### Fully free, zero Gemini dependency

Everything above runs on a locally-hosted open-weight model. No paid API, no billing
account, no credit card, no network call at inference time. `analysis_source` is
`multilingual_local` and never claims to be Gemini. Gemini remains wired as the nominal
primary behind the circuit breaker, gated by `GEMINI_ENABLED` (currently `false`).

## Phase 4 — Avatar (2026-07-28)

Presentation layer only. No detection logic touched — `multilingual_local.py`,
`language_detect.py`, `worker.py` and every other backend file are unchanged from
Phase 3, and that is checkable rather than claimed: `git status --short backend/` is
empty across the whole phase. If the avatar ever looks wrong, the fix is in the avatar or
it is a Phase 3 accuracy issue; it is never a quiet threshold tweak.

Scope, the honesty constraint and the measured numbers behind both are in
[`docs/phase4-scope.md`](phase4-scope.md).

| Step | Delivered | Evidence |
|------|-----------|----------|
| 0–1 | Scope + approach decision | `phase4-scope.md`; CSS chosen over Framer Motion / Lottie |
| 2 | Five states as one SVG | `phase4-step2-states.png` — all five plus measured geometry |
| 3 | Wired to real polled output | `phase4-step3-live.png` — 3 moods, all `multilingual_local` |
| 4 | Restraint documented at point of definition | comment on the `angry` block in `Avatar.css` |
| 5 | Performance measured | 0.400ms median commit; reduced-motion ablation isolates paint |
| 6 | Analyzing-state timeout | `phase4-step6-timeout.png` — 4 cases against the real failure |

**What it does.** A single inline SVG character (`frontend/src/components/Avatar/`) whose
expression is driven by CSS custom properties, wired to the same polled
`mood`/`analysis_status` that `pollAnalysis` already writes into `useChat`'s `messages`
array — the avatar reads the newest message off that array, so there is no second fetch
and no way for the face and the message list to disagree. Five states: `idle` (calm plus
every no-data case), `neutral`, `frustrated`, `angry`, and `analyzing` (covering the
measured ~422–638ms send→`complete` window). No sixth state — no confidence display, no
toxicity- or heat-driven variants, nothing the pipeline does not emit.

**Honesty constraint.** Angry detection is measured at 6/15
([`phase3-results.md`](phase3-results.md)), behind a regression floor with zero margin. An
avatar that renders angry as an alarm — flashing, shaking, alert-red — would present a
coin-flip as a diagnosis, in the most confident medium the product has. So angry differs
from frustrated by a small, *measured* step: ~1.6–1.8× frustrated's displacement from
neutral along the same three axes (eye width, mouth depth, brow rise), introducing no new
visual vocabulary at the top of the scale. The ratio table lives next to the values in
`Avatar.css` so a later edit cannot drift past it unnoticed, and `/?avatar-debug` prints
the numbers for re-measurement. Screen-reader copy says "reads as angry", not "is angry",
for the same reason.

This is not only a design position — it showed up live. One of Phase 3's nine missed
`angry` fixtures, *"Forget it. I'm done asking you for anything."*, came back
`frustrated` during Step 3 testing, and the avatar showed amber rather than clay. The
6/15 limitation happening in front of a user, represented honestly, rather than sitting
in a results table.

**Technical decisions worth knowing.** CSS transitions over Framer Motion — the latter was
never actually a project dependency (an earlier assumption that it was turned out to be
false; `package.json` had only `react` and `react-dom`). Step 5's profiling then closed
the question properly rather than leaving it unfired: the transitions *do* cost a little
frame time, but a reduced-motion ablation running the identical 21 React commits returns
p95 to baseline, which places the cost in `fill`/`stroke` repaint rather than React
overhead — so an animation runtime would have added weight without addressing it. Render
cost is 0.400ms median per commit against a 16.7ms frame budget. Acceptable, no change.

**Known gap, now contained rather than fixed.** `pollAnalysis` leaves a message in
`pending` forever on a single failed fetch, because the poll loop does not reschedule
after a thrown error. Step 6 adds a 3s client-side deadline that forces the avatar to
`idle`, verified against the real bug rather than a mock — a genuine CORS origin mismatch,
`analyzing` at +2849ms, `idle` by +3364ms. The deadline is keyed on message id rather than
a boolean, so a late real result is suppressed for that one message (confirmed: a real
`mood=frustrated` arriving at +4013ms left the avatar on `idle`) while the next message
animates normally. **The poll-loop retry behaviour is still unfixed** and belongs to a
separate change to `useChat.ts` — "Step 6 done" does not mean `pollAnalysis` is fixed.

---

## Measured numbers (all real, measured in-project)

| Metric | Value | Phase |
|--------|-------|-------|
| POST /messages, server-side | 27–42ms (median 41.1ms over 24 sends, p95 85.8ms) | 2 |
| POST /messages, re-observed | 19–46ms | 3 |
| End-to-end, send → `complete` | 422–638ms | 3 |
| **Multilingual model inference** | **median 40.0ms**, min 27.8, p95 49.4, max 56.1 (n=20) | 3 |
| Model cold load | 8.22s standalone, 7078ms in worker; first inference 469.6ms | 3 |
| Local lexicon fallback compute | **median 0.014ms**, p95 0.026ms (n=1000) | 2 |
| Cache hit (Redis GET) | median 1.085ms, p95 1.697ms (n=200) | 2 |
| Circuit OPEN short-circuit | 3.87–6.72ms vs 3008–3014ms CLOSED | 2 |
| Cache hit rate, realistic traffic | **37.5%** (9 hits / 24 sends, 12 unique) | 2 |
| Gemini, healthy, `thinking_level="low"` | median 1410ms, 5/5 under 2s | 2 |
| Gemini, default thinking level | 6.0–12.6s, 0/5 under 2s, one 30s timeout | 2 |
| Gemini, after recovery | 2050–2154ms | 3 |

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

**`CORS_ORIGINS` is an exact string match, so `127.0.0.1` is not `localhost`.** The
allowlist is `['http://localhost:5173']`. Serving the frontend from
`http://127.0.0.1:5173` — or from any other port — fails preflight with
`OPTIONS /messages -> 400 Bad Request`, and the browser-side symptom is deeply
misleading: the send appears to do nothing, no message row is created, and because
`pollAnalysis` swallows the fetch error the UI just sits there. Use `localhost:5173`
exactly, or add the origin you are using to `CORS_ORIGINS` in `backend/.env`. Found in
Phase 4 Step 3 while driving the real UI from a headless browser on a non-default port.

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

- **Two blockers before `GEMINI_ENABLED=true`** — the prompt's "close relationship"
  framing and the mood-vocabulary mismatch. Detail at the top of this file and in
  [`prompts.md`](prompts.md).
- Cache lookup is wasted work while the circuit is OPEN (see above).
- No single-flight: duplicate concurrent sends each do full work.
- The frontend renders `mood` (as the Phase 4 avatar) but still shows nothing for
  `toxicity_score`, `heat_score` or `rewrite_suggestion`. The rewrite suggestion is the
  valuable one and deserves its own phase rather than a caption bolted to the avatar.
- **`pollAnalysis` abandons a message permanently on a single failed fetch — contained
  by Phase 4 Step 6, root cause still unfixed.** In `useChat.ts` the `catch` around
  `getAnalysis` logs and `return`s without rescheduling the next tick and without moving
  `analysisStatus` off `pending`, so one transient network error strands that message in
  `pending` for the life of the session.

  *Contained:* the avatar's 3s deadline (`useAvatarState.ts`) forces `idle` once
  `pending` has lasted longer than any healthy request, so the visible symptom — a
  spinner that never stops — cannot occur. Verified against the real bug rather than a
  mock: serving the frontend from a non-allowlisted origin makes the request genuinely
  fail, and the avatar reverts at ~3.36s (`docs/phase4-step6-timeout.png`).

  *Still broken underneath:* the message keeps no analysis and is never retried. The
  containment is presentation-only and deliberately so — the real fix is a bounded retry
  with backoff in the poll loop, which touches `useChat`'s core logic and is its own
  change. **Worth doing separately.** Do not let the working avatar disguise it.
- Grafana was skipped as optional.

## Conventions

- Commits: `Phase N, Step M: <description>` (or `Phase N, Steps M-K:` when a commit
  spans several), authored by Ananya, **no AI attribution and no `Co-Authored-By`**.
- Every step needs pasted real output before it counts as done.
- Accuracy numbers are reported with their margin. A threshold met at the boundary is
  never written as "passes" without saying so.
- Secrets live in `backend/.env` (gitignored); `.env.example` documents the keys.
- Docs are updated in the same commit as the code they describe.

## Running it

```bash
docker compose up -d                      # postgres, redis, prometheus
cd backend
.venv/Scripts/python.exe -m alembic upgrade head
.venv/Scripts/python.exe -m uvicorn app.main:app --reload --port 8000   # terminal 1
.venv/Scripts/python.exe -m arq app.worker.WorkerSettings               # terminal 2
.venv/Scripts/python.exe -m pytest                                      # tests
```
