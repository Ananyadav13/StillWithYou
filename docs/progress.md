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
| Phase 5 — WhatsApp Web extension | 🟡 Proof of concept. Code complete, backend + fixture evidence done; three real-site captures outstanding |

**Everything runs.** Postgres, Redis and Prometheus are in compose; the API, the
ARQ worker and the frontend all start clean; **33 tests pass** (5 Phase 2
failure-injection, 6 cache-key, 10 Phase 3 regression, 12 Phase 5 preview-endpoint and
startup).

**Note the API now takes ~32-34s to become ready**, because the multilingual model loads
during startup rather than behind the first request. That is deliberate — see the
cold-start fix in the Phase 5 section.

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
- ~~The frontend renders `mood` only.~~ **Closed by Phase 5.** The `NudgeBanner` now
  renders `heat_score` (above 0.35) and `rewrite_suggestion` as its body text.
  `toxicity_score` is still fetched and displayed nowhere — deliberately, since it
  measures cruelty rather than escalation and the banner is about the latter.
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

## Phase 5 — WhatsApp Web extension (2026-07-28)

Scope, risk statement and full evidence: [`phase5-scope.md`](phase5-scope.md).
Harness output: [`phase5-evidence.txt`](phase5-evidence.txt).

**Status: proof of concept, not a feature.** It is a local unpacked Chrome extension,
loaded through developer mode from a checkout. **It is not published, not submitted to
the Chrome Web Store, and not distributed.** It exists as a portfolio demonstration of
how to build against a hostile integration surface, not as something anyone should
install. Tested only against the author's own account and self-authored test messages;
no real contact's messages were read or captured.

### The read-only, non-destructive boundary

> The extension **reads** the compose box's text and **adds** an overlay of its own. It
> performs no other interaction with WhatsApp.

It never writes to the compose box, never calls `preventDefault`, attaches no `keydown`
handler at all, binds nothing to the send button, never patches `fetch`/XHR/WebSocket,
never enters the page's main world, and never reads the message transcript. The banner
is appended to `document.body` as a fixed overlay positioned from the compose box's
bounding rect — never inserted into WhatsApp's tree — so it cannot shift their layout or
be caught by their event delegation. `sendButton` is resolved as a health canary and
**never bound**, with the constraint written next to it in `selectors.js`, because that
is the file where someone would cross the line without noticing.

### The three failure modes handled

1. **WhatsApp's DOM changes.** Fallback selector chains, structured `selector_failed`
   logging, a persisted counter in `chrome.storage.local`, `null` instead of throwing,
   and a visible *"StillWithYou couldn't attach — WhatsApp may have updated"* indicator.
   Verified by breaking every rung of the compose-box chain: no crash, indicator shown,
   failure counted, WhatsApp's own send still working; then reverted and green again.
2. **Backend unreachable.** Silent from WhatsApp's side — no banner, no indicator,
   nothing added to the page, one logged line. Verified against a dead port.
3. **Backend slow.** `AbortController` deadline at 3s, aborting at a measured **3017ms**
   against a server answering at 6s. Not hypothetical: a cold API process pays the
   model's 8.22s load, and the first request during that window measured **3.50s**.

This one is loud and the other two are silent, deliberately. A broken selector means the
extension is silently useless, and silence would be read as "your message is fine" — an
absent warning must never be mistakable for a verdict of calm. A down backend is not
something the user can act on, and on a dev machine it is the normal state.

### What this phase added outside the extension

- **A real `NudgeBanner` in the main app.** The brief assumed one existed to port; it did
  not — `heat_score` had been fetched into frontend state since Phase 1 and rendered
  nowhere. So this is the first thing in the project to display it, and the component
  lives in the React app with the extension's overlay as the port, rather than the other
  way round. Threshold `0.35`, justified from a measured sweep over all 45 fixtures in
  `frontend/src/config/nudge.ts`, deliberately **not** set to the fitted optimum of 0.23
  (whose margin over the highest calm fixture is one fixture) and biased to under-warn.
- **`POST /analyze-preview`** — same analysis path, writes no row and enqueues no job.
  The extension analyses on a typing pause, so reusing `POST /messages` would leave
  several partial drafts of every WhatsApp message in the database. 8 new tests.

### Two things worth being honest about

**The extension is a worse citizen of the backend than the main app is.** The main app
does not debounce — it analyses on send only, and the comment on `sendMessage` argues
explicitly against debouncing. The extension cannot copy that, because knowing when the
user sends means listening on the send button or Enter, which its own boundary forbids.
So the ~1.5s debounce is a *departure*, not an imitation, costing roughly one extra
request per typing pause. It is affordable only because the analyzer is 40ms and nothing
is persisted.

**`/analyze-preview` breaks the project's central rule on purpose.** Analysis runs
synchronously in the request path, which `POST /messages` may never do. The justification
is recorded in the module docstring: Gemini is never called from it regardless of
`GEMINI_ENABLED`, the analyzer is 40ms rather than 1410ms, nothing is persisted so there
is no message to protect, and the caller holds a 3s deadline. A test asserts the Gemini
part rather than trusting it.

### Cold-start fix — the risk this phase found, then closed

**The risk.** `/analyze-preview` runs the multilingual model in the API process, and the
model was loaded on a background thread at startup so boot would stay fast. That put the
load in a race with real traffic. Measured on a fresh process with an immediate request:
the socket opened at **5.3s**, the model was not resident until **34.0s**, and the first
request **timed out at the extension's 3s client deadline**. Worse, `/health` answered a
flat `{"status": "ok"}` for the whole window — the only readiness signal there was, and
it said "fine" while the endpoint was unusable.

This is the trade Phase 2 rejected for Gemini, made again by accident: a fast boot bought
by charging the cost to whichever real request arrived first.

**Two corrections to the recorded numbers.** The documented **8.22s load was wrong by
4×** — it came from a standalone process on an idle machine, and re-measured against the
real working set (Postgres, Redis, Prometheus, a second uvicorn, a browser) it is
**27.6–34.0s**. About 9s of that is a network metadata check to huggingface.co: **33.9s
online against 24.9s with `HF_HUB_OFFLINE=1`**. That flag is a genuine ~9s saving and is
deliberately **not** set, because it would break the first run on a machine without the
model cached — recorded as a follow-up rather than taken quietly.

**What changed.** `load_preview_model()` is awaited from `lifespan` (the app already used
the lifespan context manager; `@app.on_event` is deprecated in the installed FastAPI
0.115.0). Verified rather than assumed: **uvicorn does not open the listening socket
until lifespan startup returns** — the port now accepts at 34.2s, after
`preview_model_ready`, where before it accepted at 5.3s with the load still running. So
during boot a caller gets an immediate connection refusal rather than a hang, which is
the extension's already-silent `unreachable` path. It loads via `asyncio.to_thread` so
Ctrl+C still works during a 30s boot, and a failed load is logged and swallowed rather
than aborting startup.

**The first attempt was incomplete, which is the part worth remembering.** Eager loading
alone still left request #1 at 403ms server-side against 146ms for #2. Loading weights is
not the whole cold start — the first forward pass initialises lazy kernels and thread
pools, which Phase 3 had already measured as a 469.6ms one-off. `warm()` had never run an
inference, so the cold start had just moved one layer down. It now runs one throwaway
inference; per-call logic in `analyze_multilingual` is untouched.

**After:** first request **200ms server-side** against 164ms and 196ms for the next two —
indistinguishable from steady state, roughly 3× margin on the deadline. `/health` now
reports `preview_model` as `ready` / `unavailable` / `disabled` instead of a flat `ok`;
`unavailable` is the one worth alerting on, because `analyze_multilingual` silently
degrades to the Phase 2 lexicon and a broken model is otherwise invisible.

**The tradeoff, stated plainly:** boot-to-ready goes from ~5.3s to **32.1–34.2s**, and
that is accepted. A slow, visible, once-per-restart cost paid by the operator beats a
hidden one paid by whichever user happened to be first — and it is now observable rather
than inferred. `PREVIEW_ENABLED=false` skips the load entirely, asserted by a test.

Re-runnable: `backend/scripts/measure_cold_start.py`. Regression: **33 tests pass**
(29 + 4 for the startup contract), with the Phase 3 floors unmoved at `angry 6/15`,
`32/45` — the fix touches when the model is built, never how it is used.

### Track A — apologetic text read as hostility (2026-07-29)

Full write-up: Step 12 in [`phase3-results.md`](phase3-results.md).

The main app's nudge banner showed **"Reads as angry · heat 0.60"** under the message
*"i really apologize"*. **Checked for a wiring bug first** — the banner could plausibly
have been stale, the same class of defect as Phase 4's `pollAnalysis` hole. It was not:
instrumenting `NudgeBanner` to log `displayed_message_id` against `latest_message_id` and
replaying the exact seven-message sequence through the real UI gave `is_stale: false` on
all seven sends. The banner is faithful; the model is wrong.

Six apologetic fixtures added, labelled before any run, corpus 45 → 51. **Result 0/6**,
with the prediction pre-registered beforehand. The mechanism guess was half wrong in an
informative way: the warm lexicon *did* fire on `sorry yaar` and cut heat from ~0.60 to
0.19, but `_mood()` returns `frustrated` for any negative top class regardless of heat,
so the label failed while the product behaviour was correct. **0/6 on the mood label,
but 4/6 on what the user actually sees.**

This is a *distinct* failure mode from the documented `angry 6/15`, and the opposite one:
under-reacting to cold hostility versus over-reacting to self-blame. It is also worse for
the product — a missed angry message leaves the user where they'd be without
StillWithYou, while a false nudge on an apology interrupts a repair attempt.

**No floor value moved**, and that is the honest part: floors are counts of correct
answers, the six new fixtures contributed zero, and the original 45 re-ran byte-identical
at 32/45. The analyzer did not regress — the corpus stopped hiding a weakness it always
had. Headline accuracy is now **32/51 (62.7%)**, down from 71.1%, for the same reason
83% became 71%. `LANGUAGE_BAR` re-baselined 39 → 44 to hold the same 87%.

**Nothing in `multilingual_local.py` was changed.** No word added to `_WARM_EN`, no
threshold moved, no model swapped. Adding `apologize` to the warm list would score better
on exactly the six fixtures written to expose the problem — the contamination Step 4
already caught once.

**Also recorded: the nudge threshold's clean record is gone.** `nudge.ts` chose 0.35
partly because 0/18 calm-or-neutral fixtures reached it. On 51 that is **4/24**. The
caveat written beside the number predicted this; it is left in place rather than
rewritten, because it was right.

### Runbook — do not start uvicorn and the ARQ worker at the same time

Second-order cost of last session's eager-load fix, found the hard way. Both processes
now warm their own copy of the 1.1GB model at startup. Started **together** on a machine
with ~2.3GB free (Chrome, Brave, VS Code, WSL resident), they contend for memory that
neither can get: Windows pushed 1.4GB into Memory Compression and startup hung past
**10 minutes** with no error — just `Waiting for application startup`. Started
**sequentially** the same loads took **7s** and **12.8s**.

The mechanism is worth stating precisely, because "start things one at a time" does not
convey it: two independent processes each try to fault in a 1.1GB model, and under
contention the pair is far worse than either alone — not 2× slower but effectively
stalled, because neither can hold its working set. The eager-load fix was still the right
trade (a visible one-time boot cost beats a hidden per-request one), but it turned a
previously-harmless startup order into a blocking one.

```bash
# correct order
uvicorn app.main:app --port 8000     # wait for {"preview_model":"ready"}
arq app.worker.WorkerSettings        # only then
```

Also: **check for orphaned processes first.** Four stale `python.exe` (two uvicorn on a
test port, two ARQ workers) from earlier sessions were still resident and competing for
the same memory. That pre-flight has now caught something real in three separate
sessions — Phase 3's contaminated runs, Phase 5's cold-start work, and this.

### Remote selector config — closing the manual-reconfiguration gap

Design and threat model: [`phase5-remote-config.md`](phase5-remote-config.md). Evidence:
[`phase5-config-evidence.txt`](phase5-config-evidence.txt), **45/45 checks**.

**The gap.** The first real test against `web.whatsapp.com` made the maintenance cost
concrete. Any selector change meant: edit `selectors.js`, reload the unpacked extension,
re-run the harness, re-test on the real site — and every user of the extension has to do
all of it, with the extension dead until they do. For an integration surface that *will*
break periodically by design, "the fix requires a release" is the actual failure mode,
not the broken selector.

**What changed.** Selectors now come from `extension-config/selectors.json`, fetched at
runtime from `raw.githubusercontent.com` (scoped `host_permissions`, repo path only, not
the whole domain). Three tiers, each verified and each logging `config_source` on every
load: `remote` → `cache` (last-known-good in `chrome.storage.local`) → `hardcoded`
(frozen snapshot, the only selector data still shipping in the extension). The fetch is
never awaited — the extension boots on the snapshot and upgrades in place, because
putting a third-party HTTP request in WhatsApp Web's page-load critical path is the
failure this phase exists to avoid.

Also added: self-tuning selector order (the index that last resolved is tried first and
persisted, so a partial DOM change stops re-paying failed queries on every mutation) and
`fixtures/sync-snapshot.mjs`, which catches drift between the JSON and the frozen copy.

**A bug the tests found.** A reachable-but-*malformed* config originally returned
`unavailable` without consulting the cache — so one bad push dropped every client to the
frozen snapshot, while merely being offline correctly kept last-known-good. Backwards: a
bad push is both likelier and more in need of a limited blast radius. Both failure paths
now share one `fallbackToCache`.

**Step 5, the payoff.** Every selector replaced with a dead one, then **only the JSON
edited** — no extension file touched, nothing reloaded:

```text
BEFORE  config v3: health=detached, indicator=true
>>> edited selectors.json only: v3 -> v4. No extension code changed. <<<
AFTER   config v4: health=attached, indicator=false
Recovery required: 1 JSON edit. Extension code changed: 0 files.
```

**What this does NOT solve.** It handles selector *strings* changing while the structure
stays reachable — the common case. It does **not** survive structural change: a closed
Shadow DOM, a cross-origin iframe, or a canvas-rendered compose box is unreachable by any
CSS selector, and no config push helps. That still needs code. The health check fires
correctly in those cases; the extension simply cannot be fixed remotely.

**Verified locally, not against GitHub.** The harness serves the config from a local HTTP
server, which is what makes a mid-run config edit testable at all. Not yet proven: that
`raw.githubusercontent.com` is reachable from the extension, and that GitHub's ~5-minute
raw CDN cache behaves as documented. Both need the config file pushed first.

### Track B — remote config verified against the live GitHub CDN (2026-07-29)

Evidence: [`phase5-live-cdn-evidence.txt`](phase5-live-cdn-evidence.txt); full write-up in
[`phase5-remote-config.md`](phase5-remote-config.md).

`extension-config/selectors.json` is now on `main` and served by GitHub. All three live
checks pass against the real CDN, not a local test server:

- **B1** — the shipping `config_source.js`, unmodified, returns `source: remote` in
  1134ms cold / 183ms warm, writes the cache, and the extension installs it and reports
  `health: attached`.
- **B2** — real propagation measured at **248.4s (4m 08s)** from `git push` to the new
  version being visible, against a measured `Cache-Control: max-age=300`. The ~5 minute
  figure was previously an estimate; it is now a measurement.
- **B3** — a deliberately malformed config on a throwaway branch falls back to
  **cache**, not `unavailable`, with `reason: invalid:empty_selectors:composeBox`, and the
  good cache entry survives. The bug the local harness found holds fixed in the wild.
  `main` never served a broken config; the branch `test/malformed-config` is retained
  because `run-live-malformed-check.mjs` depends on it as a permanent fixture.

**The best result was unplanned.** During B2's polling, three attempts returned
`source=cache` — live fetches to GitHub transiently failed and the cache tier engaged on
its own, in real conditions. The fallback demonstrated by an actual intermittent failure
rather than an injected one, the same way Phase 2's resilience layer was validated by a
genuine Gemini outage.

**Still uncovered:** that Chrome grants the fetch under the manifest's
`host_permissions` with the extension actually loaded. Everything above runs
`config_source.js` as the service worker would, but outside the extension sandbox.

### Two real bugs found by the first live WhatsApp Web test

Worth recording because both were invisible to the fixture harness and only appeared
against the real site.

**1. The health check reported normal operation as an outage.** WhatsApp renders no
compose box until a chat is opened — the landing state is a splash screen — so the
indicator fired on every load before the user clicked anything. That is the worst
available failure for a health signal: one that fires during normal operation trains the
user to dismiss it, so it carries no information on the day the DOM actually moves.
Fixed with an explicit `conversationOpen` precondition and three states: `idle` (no chat
open, silent), `attached`, `detached` (the real outage). Regression-tested.

**2. Logging and failure-counting ran on every DOM mutation.** WhatsApp Web mutates
continuously, so a single outage produced dozens of identical warnings per second and
turned `selector_failures` into a count of observer ticks rather than of outages — a
number that looked like evidence and measured nothing. Now latched per transition, with
the observer coalesced at 250ms. Measured: **60 mutations in 3s → 1 log, 1 counted
incident** (was dozens). Recording moved into the health check, which is the only place
that can tell a real outage from an unopened chat.

*Correction to an earlier note in this file:* these were not caused by unbounded polling.
The timestamps show MutationObserver re-checks during WhatsApp's own SPA re-renders, with
genuine multi-minute idle gaps between bursts. The defect was duplication *within* those
bursts, not a runaway timer.

**Also diagnosed:** `analysis_unavailable / reason: endpoint_absent` on the live test was
a stale uvicorn — a live server answering `/health` in 2ms but 404ing `/analyze-preview`,
i.e. one started before that route existed. `endpoint_absent` (HTTP 404) versus
`unreachable` (connection refused) is why that was a two-minute diagnosis rather than a
guess; the classification in `api.js` earned its keep. Fix is to restart the backend.

### Still outstanding

Three DONE WHEN criteria need a logged-in WhatsApp Web session and are **not** claimed as
done: that the manifest loads on the real site (Step 1), that the selectors match
*today's* real DOM (Step 3), and how the banner sits over a real conversation (Step 5).
The fixture harness proves the extension's own logic — 50/50 checks against the real
sources and the real backend — but a fixture is a copy of a moving target and cannot
prove the copy is current. Capture procedure in `phase5-scope.md`.

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
