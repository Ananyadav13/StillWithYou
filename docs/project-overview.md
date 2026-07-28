# StillWithYou — complete project overview

A single self-contained document explaining what this project is, why it exists, how it
is built, what has been proven to work, and what has not. Written to be read cold by
someone with no prior context — a recruiter, an interviewer, a new collaborator, or a
language model being given the project as background.

**Repository:** `github.com/Ananyadav13/StillWithYou`
**Author:** Ananya
**Status as of 2026-07-28:** Phases 1–4 complete plus a Phase 5 proof of concept, 33
passing tests. Phase 4 (the mood avatar) is built, wired to real pipeline output and
measured; it is a presentation layer only and changed no backend code. Phase 5 is a
read-only WhatsApp Web extension, unpublished and undistributed, with three real-site
captures still outstanding.
**Last updated:** 2026-07-28

---

## Table of contents

1. [The one-paragraph version](#1-the-one-paragraph-version)
2. [The problem](#2-the-problem)
3. [What the system does today](#3-what-the-system-does-today)
4. [Architecture](#4-architecture)
5. [Technology choices, and why](#5-technology-choices-and-why)
6. [Phase 1 — the chat skeleton](#6-phase-1--the-chat-skeleton)
7. [Phase 2 — the resilience layer](#7-phase-2--the-resilience-layer)
8. [Phase 3 — multilingual analysis](#8-phase-3--multilingual-analysis)
9. [Phase 4 — the avatar layer](#9-phase-4--the-avatar-layer)
10. [Every measured number](#10-every-measured-number)
11. [Testing strategy](#11-testing-strategy)
12. [Engineering practices this project demonstrates](#12-engineering-practices-this-project-demonstrates)
13. [Hard problems solved](#13-hard-problems-solved)
14. [Known limitations, stated plainly](#14-known-limitations-stated-plainly)
15. [Roadmap](#15-roadmap)
16. [Interview talking points](#16-interview-talking-points)

---

## 1. The one-paragraph version

**StillWithYou is a real-time communication assistant that analyses the emotional tone of
a message before it is sent, and tells the sender when it is likely to land harder than
they intend.** It works across English, Hindi in Devanagari script, and Hinglish
(romanized Hindi code-switched with English) — the three registers people in India
actually type in. Technically it is a FastAPI + Postgres + Redis backend with an
asynchronous job queue, a circuit breaker around a third-party LLM, a locally-hosted
transformer model as the analysis engine, Prometheus instrumentation, and a React
frontend. The engineering emphasis is **reliability and honest measurement**: the system
is built so that no third-party outage can lose a user's message, and every capability
claim in the documentation is backed by pasted output from a real run, including the
claims that are unflattering.

---

## 2. The problem

### The human problem

Most damage in a conversation is done by messages the sender did not realise were harsh.
Not abuse — ordinary escalation. "You always do this." "Forget it." "Whatever." Sent in
thirty seconds of frustration, read as a verdict on someone's character.

The intervention StillWithYou aims at is narrow and specific: **a short pause between
typing and sending, with a second opinion attached.** Not censorship, not autocorrect for
feelings. A signal — *this message reads as angrier than you may have meant; here is the
specific thing that makes it land that way.*

### Who it is for — an important scoping decision

StillWithYou mediates communication between **any two people**: friends, roommates,
siblings, classmates, colleagues, parent and child. **Not specifically romantic
partners.**

This distinction is load-bearing rather than cosmetic. An early version of the Phase 3
test corpus was written entirely as partner-to-partner messages, and had to be rewritten
from scratch. Writing every sample as a couple exchange bakes in an assumed baseline of
intimacy and empathy that most real conversations do not have — it changes what counts
as "normal warmth", what counts as cold, and therefore what the system learns to flag.
The corpus now spans friends, roommates, siblings, classmates, colleagues and family,
with the relationship recorded on every sample so the spread can be audited rather than
trusted.

### The linguistic problem

The users this is built for do not type in one language. A single message is routinely:

```
Yaar tune phir se poori raat light on chhod di. Bill dono ka aata h.
```

That is Hindi grammar, Latin script, English nouns, and compressed SMS spelling
(`h` for `hai`), all in one sentence. Off-the-shelf sentiment tools do not handle it.
Measured in this project: the standard `langdetect` library scores **0 out of 15** on
Hinglish messages — it never once identifies them as Hindi, guessing Indonesian,
Estonian, Tagalog, Italian and Swahili instead.

---

## 3. What the system does today

A user types a message in the React frontend and sends it. Then:

1. `POST /messages` persists the message to Postgres and returns **201 in ~20–45ms**.
   The analysis has not run yet, and deliberately does not block this response.
2. An analysis job is pushed onto a Redis-backed ARQ queue.
3. A separate worker process picks it up and:
   - detects the language (`en` / `hi` / `hi-en-mixed`),
   - checks a Redis cache keyed on a hash of the normalised message,
   - consults the circuit breaker guarding the Gemini API,
   - runs the local transformer model (currently the active path),
   - writes `mood`, `toxicity_score`, `heat_score` and a `rewrite_suggestion` back to the
     message row, moving it from `pending` to `complete`.
4. The frontend polls for the result, which typically lands **within 400–650ms of the
   send**.

Output for one real message, end to end:

```
sent: अपनी गलती मान लो बस। सारा इल्ज़ाम मुझ पर डालना बंद करो, बकवास लगता है।
POST /messages -> 201 in 46.4 ms
pending -> complete after 425 ms
  analysis_status    complete
  analysis_source    multilingual_local
  mood               angry
  toxicity_score     0.7
  heat_score         0.68
```

The four mood labels are `calm`, `neutral`, `frustrated`, `angry`. `toxicity_score`
measures cruelty; `heat_score` measures escalation energy. They are deliberately separate
— a shouted *"I NEVER said that!"* is hot without being cruel, and a calmly-worded
dismissal is the reverse.

---

## 4. Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│  React 18 + TypeScript + Vite + Tailwind                            │
│  ChatWindow · MessageBubble · MessageInput · useChat                │
└───────────────┬─────────────────────────────────────────────────────┘
                │ POST /messages          GET /messages/{id}/analysis
                ▼
┌─────────────────────────────────────────────────────────────────────┐
│  FastAPI (uvicorn)                                                  │
│  • commits the message FIRST, enqueues SECOND                       │
│  • a broker outage cannot fail a send                               │
│  • serves /metrics for Prometheus                                   │
└───────┬──────────────────────────────────┬──────────────────────────┘
        │                                  │
        ▼                                  ▼
┌────────────────┐              ┌──────────────────────────────────┐
│  Postgres 16   │              │  Redis 7                         │
│  messages      │              │  • ARQ job queue                 │
│  + analysis    │              │  • circuit breaker state (Lua)   │
│    columns     │              │  • analysis cache (SHA-256 keys) │
│  Alembic       │              │  • metric counters               │
└────────▲───────┘              └──────────────┬───────────────────┘
         │                                     │
         │        ┌────────────────────────────▼────────────────────┐
         │        │  ARQ worker (separate process)                  │
         └────────┤                                                 │
                  │   detect_language()                             │
                  │        ↓                                        │
                  │   cache lookup ──── hit ──► write, done         │
                  │        ↓ miss                                   │
                  │   circuit breaker .allow()                      │
                  │        ↓                                        │
                  │   [Gemini]  ← nominal primary, config-gated OFF │
                  │        ↓ unavailable / disabled                 │
                  │   analyze_multilingual()  ← ACTIVE PATH         │
                  │     XLM-RoBERTa on CPU, ~40ms                   │
                  │        ↓ (model load failure only)              │
                  │   analyze_locally()  ← last-resort lexicon      │
                  │        ↓                                        │
                  │   always reaches `complete`                     │
                  └─────────────────────────────────────────────────┘
```

### The central design decision

**Analysis never sits in the request path.** This was not a preference; it was forced by
measurement. Before any of the resilience work was written, the Gemini API was
benchmarked and produced a **1410ms median against a 2-second budget**, with the same
configuration yielding a 3.2s call in one run and a 30-second timeout in another.

Two conclusions followed and set the entire architecture:

1. The latency target is achievable but has almost no headroom.
2. Therefore a 99.9% persistence guarantee is **incompatible** with waiting on a
   dependency whose tail latency we do not control.

Hence: commit first, enqueue second, analyse asynchronously, and degrade gracefully at
every layer.

### The three-tier degradation ladder

| Tier | Engine | Latency | When it runs |
|---|---|---|---|
| 1 | Gemini API | ~1400–2150ms | Nominal primary; currently config-gated off |
| 2 | `multilingual_local` (XLM-RoBERTa, CPU) | **40ms median** | The active path |
| 3 | `local_fallback` (lexicon heuristic) | **0.014ms** | Only if the model fails to load |

Every tier returns the same `AnalysisResult` shape, so callers never branch on
provenance except to read `source`. A message reaches `complete` even with every external
dependency gone — that is the property the whole system is organised around.

---

## 5. Technology choices, and why

| Layer | Choice | Reasoning |
|---|---|---|
| API | **FastAPI** on uvicorn | Async-native, needed because the request path does I/O to Postgres and Redis; Pydantic validation shared with the schema layer |
| Language | **Python 3.13** | The ML ecosystem (`transformers`, `torch`) is Python-first, and the analysis engine is the heart of the product |
| Database | **Postgres 16** + SQLAlchemy 2.0 async + asyncpg | Relational integrity for messages; async driver so DB I/O does not block the event loop |
| Migrations | **Alembic** | Schema changes are versioned and reversible — used four times, including a production bug fix |
| Queue | **ARQ** on Redis | Far lighter than Celery for one job type; async-native, so it shares the FastAPI concurrency model |
| Cache / state | **Redis 7** | One dependency serving four jobs: queue, circuit breaker state, analysis cache, metric counters |
| Metrics | **Prometheus** + `prometheus_client` | Standard; counters live in Redis so two processes report through one endpoint |
| ML | **transformers** + **torch (CPU)** | Local inference, zero API cost, no network at inference time |
| Model | `cardiffnlp/twitter-xlm-roberta-base-sentiment` | See Phase 3 for the full selection rationale |
| Frontend | **React 18 + TypeScript + Vite + Tailwind** | Vite for fast iteration; TypeScript because the analysis payload has a real shape worth enforcing |
| Infra | **Docker Compose** | Postgres, Redis and Prometheus reproducible with one command |

### Two non-obvious choices

**Redis for circuit breaker state, not in-process memory.** An in-memory breaker would let
N worker processes each independently discover that a dependency is down — N times the
wasted timeout. State in Redis means every worker sees the same circuit. The consequence
is that the decision and the state transition must be atomic, which is why each breaker
operation is a **Lua script executed server-side by Redis** rather than a read-then-write
from Python. Two workers both reading "open" and both electing themselves the probe would
defeat the purpose.

**Metric counters in Redis, not a second exporter.** The API and the worker are separate
processes, but the interesting counters increment in the worker while `/metrics` is served
by the API. Rather than run a second exporter and federate, counters are Redis hashes read
at scrape time. A Prometheus counter is precisely an `INCR`.

---

## 6. Phase 1 — the chat skeleton

**Goal:** a working chat application with persistence and a first analysis integration.

Delivered: React frontend (ChatWindow, MessageBubble, MessageInput, `useChat` hook),
FastAPI backend, Postgres persistence via SQLAlchemy + Alembic, and the first Gemini
integration behind `POST /messages`.

The architecturally important decision made here, which everything later depends on:
**the message row is committed before the analysis is attempted**, and the analysis call
is wrapped so no failure can propagate to the client. A message the user typed is never
lost because a third-party API was unavailable.

---

## 7. Phase 2 — the resilience layer

**Goal:** make the system survive the failure of its most important dependency, and prove
it with injected failures rather than assertion.

This phase began by writing down the target **before** writing any code
(`docs/phase2-slo.md`):

| # | Objective | Target |
|---|---|---|
| 1 | Sends receiving an analysis result within 2s | 95% |
| 2 | Sends whose message persists regardless of Gemini's state | **99.9%** |

Objective 2 is explicitly the load-bearing one. Objective 1 may degrade to a
lower-fidelity answer under failure; objective 2 may not degrade at all.

### What each step delivered

| Step | Delivered | Evidence |
|---|---|---|
| 0 | SLO document | SLI/SLO + 4 failure modes with a measured baseline |
| 1 | Structured JSON logging | 5 sends → 5 structured lines with real latencies |
| 2 | Redis + ARQ worker | Worker connects, `ping_job` round-trips |
| 3 | Async job + polling endpoint | **POST returned in 27–42ms while Gemini hung >45s** |
| 4 | Send-only analysis trigger | 0 backend requests in a 20s typing window, 1 on send |
| 5 | Redis circuit breaker | Trips after 3 failures; **3008ms → 3.87ms when OPEN** |
| 6 | Local fallback analyzer | `complete` in 267ms with the circuit OPEN |
| 7 | Analysis cache | `cache_miss` then `cache_hit` on the same key |
| 8 | Prometheus metrics | 6 metric families non-zero, scrape target healthy |
| 9 | Operational runbook | Four failure scenarios with diagnosis steps |
| 10 | Failure-injection tests | 5 passing tests |

### The circuit breaker

Three states, all state in Redis, all transitions atomic via Lua:

```
CLOSED     calls pass through. 3 consecutive failures within 30s trips it.
OPEN       calls refused immediately for 60s. Zero Gemini traffic.
HALF_OPEN  exactly one probe admitted. Success closes; failure re-opens for 60s.
```

The measured payoff: a refused call costs **3.87ms** instead of a **3008ms** timeout.

### The phase was validated by a real outage, not a simulated one

Midway through Phase 2, the Gemini API genuinely failed — all three configured keys became
unusable simultaneously. Two hung past 25 seconds on every call; the third returned
`403 PERMISSION_DENIED — "Your project has been denied access."` This was project-level,
not quota, so key rotation could not fix it.

The system kept working. Every message still reached `complete` through the local
fallback. **The resilience layer was validated by an unplanned production-shaped outage
rather than by injected failures** — which is a considerably stronger result than the test
suite alone.

---

## 8. Phase 3 — multilingual analysis

**Goal:** mood and toxicity detection across English, Hindi (Devanagari) and Hinglish,
running entirely on a free self-hosted model, with zero dependency on the blocked Gemini
API and no paid services of any kind.

### Model selection

Three candidates were evaluated on size, license and evidence of Hindi coverage.

**Chosen: `cardiffnlp/twitter-xlm-roberta-base-sentiment`** — XLM-RoBERTa-base, 278M
parameters, 3-class sentiment fine-tuned on ~198M tweets across 8 languages including
Hindi.

The deciding evidence was examined at the tokenizer level *before* any integration was
written:

```
तुम हमेशा मेरी बात अनसुनी कर देते हो
→ ['▁तुम', '▁हमेशा', '▁मेरी', '▁बात', '▁अन', 'सु', 'नी', '▁कर', '▁देते', '▁हो']    0 UNK

tum hamesha meri baat ignore kar dete ho
→ ['▁tum', '▁ham', 'esha', '▁meri', '▁baat', '▁ignore', '▁kar', '▁de', 'te', '▁ho']  0 UNK
```

`▁tum`, `▁meri`, `▁baat` and `▁kar` existing as *single vocabulary tokens* proves
romanized Hindi was present in XLM-R's pretraining corpus. That is what makes Hinglish
viable rather than byte-fallback noise, and it is precisely where the alternatives fail.

**Rejected, with reasons:**

| Candidate | Reason |
|---|---|
| `tabularisai/multilingual-sentiment-analysis` | **cc-by-nc-4.0** — the NonCommercial clause would permanently restrict the project. Technically attractive otherwise (135M params, ~2× faster, 5-class labels mapping directly onto the mood scale) |
| `pascalrai/hinglish-twitter-roberta-base-sentiment` | Built on English `roberta-base` — **no Devanagari coverage at all**. Hinglish-specialised but fails the Hindi-script requirement outright |
| `textdetox/xlmr-large-toxicity-classifier` | Binary toxic/neutral only — cannot express a 4-level mood scale. Retained as a pre-vetted alternative and later tested in Step 5 |

### Measured performance, CPU only

| Metric | Value |
|---|---|
| Model size on disk | 1117.3 MB |
| Cold load, fresh process | 8.22s (7078ms inside the worker) — **see the correction below** |
| First inference | 469.6ms (one-off warm-up) |
| Steady-state inference, n=20 | **median 40.0ms**, p95 49.4ms |
| End-to-end, POST → `complete` | 422–636ms |

**ONNX conversion was explicitly measured and rejected**, not assumed. 40ms against
Gemini's ~2050ms is roughly 50× faster; adding a build step and a second copy of the
weights to save tens of milliseconds inside an already-asynchronous job is not a
worthwhile trade. The stated revisit trigger is p95 exceeding ~250ms.

### The test corpus

**45 hand-written messages** — 15 English, 15 Hindi (Devanagari), 15 Hinglish — every one
written deliberately rather than generated, with the expected mood assigned by reading the
message *before any model was run against it*.

Design constraints applied to the corpus, each of which came from a real methodological
problem:

- **All 45 texts distinct.** An earlier draft was 10 messages rendered in three languages;
  that measures translation consistency, not per-language accuracy, and lets one poorly
  chosen message skew all three categories simultaneously.
- **Relationships varied and recorded** — 28 distinct contexts across friends, roommates,
  siblings, classmates, colleagues, family.
- **Realistic Hinglish orthography** — `nhi`, `h`, `rhi`, `mai`, `gyi`, `kr`, `bhut`, not
  textbook transliteration. Clean Hinglish would flatter the language detector against
  input it will never see.
- **Heated items 11–15 in each language are free of every term in the analyzer's own
  lexicon.** This one matters most, and section 12 explains why.

### Language detection

A three-pass detector: Devanagari Unicode range → romanized-Hindi marker list →
`langdetect` for the remainder.

**Result: 45/45.** But that number was explicitly distrusted, because the marker list was
written *after* the fixtures and by the same author — a perfect score partly measures
memorisation. It was therefore re-run against **six real messages** between the author and
their friends, supplied verbatim and not consulted while building the detector, including
three English messages with informal markers (`bro`, `bae`, `Ik`) as false-positive traps.

**Held-out result: 6/6**, with zero markers firing on any of the three English traps.
That is the number that means something.

For scale, `langdetect` alone scores **30/45**, and **0/15 on Hinglish**.

### Accuracy, and how it is reported

| language | 4-way mood | lexicon disabled | polarity (model only) |
|---|---|---|---|
| `en` | 11/15 | 11/15 | 14/15 |
| `hi` | 10/15 | 10/15 | 14/15 |
| `hi-en-mixed` | 11/15 | **9/15** | 13/15 |
| **total** | **32/45 (71%)** | 30/45 | **41/45 (91%)** |

Three columns rather than one, because a single number would be misleading. The model
emits 3 classes; the corpus is labelled with 4. A hand-written escalation lexicon and
three hand-set thresholds close that gap — so the "shipped" number partly measures the
author's own vocabulary agreeing with itself. Reporting the lexicon-disabled and
polarity-only figures alongside keeps the model's real contribution visible.

### The finding

**The weak category is not a language — it is `angry`, at 6/15, failing identically in all
three languages.**

| mood | correct |
|---|---|
| calm | 8/9 |
| neutral | 9/9 |
| frustrated | 9/12 |
| **angry** | **6/15** |

The cause is specific and interesting: **a polarity model cannot see cold contempt.**
Withdrawal and cold refusal are not linguistically negative.

| message | p_neg | classified as |
|---|---|---|
| "Don't bother explaining. I heard exactly what you said about me." | 0.18 | neutral |
| "Forget it. I'm done asking you for anything." | 0.72 | frustrated |
| "छोड़ो। अब तुमसे कुछ माँगना ही नहीं है मुझे।" | 0.57 | frustrated |

None reach the `p_neg >= 0.80` promotion threshold, yet each is among the more serious
things one person can say to another.

### Step 5: one bounded iteration, pre-registered and failed

The obvious fix was to add an independent toxicity classifier as a second signal. Before
running it, the pass criterion was **written into the results document while the model was
still downloading**:

> Keep the second model only if it turns at least **5 of the 9** missed `angry` fixtures
> into `angry`, without breaking the 6 that already pass and without dropping total
> accuracy below 32/45.

A prediction was also recorded in advance: *this will fail*, because the nine missed
messages contain no slur, no harassment, and several are outright polite, while a toxicity
classifier is trained on slurs and harassment.

**Result: 0 of 9.** Seven of the nine scored `p_toxic ≤ 0.069`. And the highest-toxicity
*calm* message in the entire corpus:

```
hinglish-01   calm   p_toxic = 0.542
  "Thak gyi hogi tu, aaj kuch mat kar, seedha so ja."
  (you must be tired, don't do anything today, just go to sleep)
```

**A message telling a friend to rest scored as more toxic than all nine genuinely angry
messages.** On this corpus the two signals are close to inverted.

The conclusion: both models are proxies for *loud* negativity. Neither has any
representation of quiet, controlled anger. Because the experiment was structured as a
read-only probe *before* any integration was written, there was no code to remove — the
intervention was abandoned at zero cost and `angry 6/15` documented as a known limitation
rather than engineered around.

---

## 9. Phase 4 — the avatar layer

**Goal:** put the detected mood on screen as an animated 2D character, without letting
the interface claim more confidence than the model has.

Scope and full measurements in [`docs/phase4-scope.md`](phase4-scope.md).

This phase is **presentation only, and that is verifiable rather than asserted**: no
backend file changed at any point (`git status --short backend/` stayed empty across all
eight steps). The avatar reads the same polled `mood` and `analysis_status` that
`pollAnalysis` already writes into the frontend's message list, so there is no second
fetch and no way for the face and the transcript to disagree.

Five states, one character: `idle` (calm, and every no-data case), `neutral`,
`frustrated`, `angry`, and `analyzing` for the ~422–638ms window while the worker runs.
No sixth state — no confidence readout, no toxicity- or heat-driven variants, nothing the
pipeline does not emit.

### The governing constraint: the interface must not outrun the model

`angry` is detected correctly 6 times in 15. That number, not any visual preference,
determined the design. An avatar that renders anger as an alarm — flashing, shaking,
alert-red — would be presenting a coin-flip as a diagnosis, in the most immediate and
most believed medium the product has. Text can hedge; a face cannot.

So the escalation from `frustrated` to `angry` is deliberately small, along the *same*
three axes, adding no new visual vocabulary at the top of the scale. Measured from the
rendered DOM rather than eyeballed, as displacement from `neutral`:

| axis | frustrated | angry | angry / frustrated |
|---|---|---|---|
| eye width | −1.0 | −1.8 | **1.8×** |
| mouth depth | +2.3 | +3.8 | **1.7×** |
| brow rise | +2.7 | +4.2 | **1.6×** |

The angry accent is a muted clay, not a saturated red. Screen-reader copy says *"reads as
angry"*, not *"is angry"*.

That table is the point. "Keep it restrained" is a judgement nobody can hold a later
change to; **~1.6–1.8× is an assertion that can be violated detectably.** It lives in a
comment beside the values in `Avatar.css`, and a dev-only inspector at `/?avatar-debug`
re-prints the measurements after any edit. This is the visual counterpart of what the
per-category regression floors did for model accuracy in Phase 3 — converting a principle
into something that can fail.

### The constraint justified itself during testing, unplanned

While capturing Step 3's evidence, one of the test sends was
*"Forget it. I'm done asking you for anything."* — which happens to be one of the nine
`angry` fixtures the model misses. It came back `frustrated`, and the avatar showed amber
rather than clay.

Nothing was wrong. The avatar showed exactly what the model believed, and the model was
underestimating. **The 6/15 limitation happening live, represented honestly, rather than
sitting in a results table** — which is a considerably better argument for the restraint
than the reasoning that produced it.

### Approach: CSS, after correcting a false premise

The phase was planned around extending Framer Motion, on the assumption it was already a
dependency. It was not — `package.json` contained only `react` and `react-dom`. Once that
was checked, the real comparison was zero new dependencies against one, for five discrete
states and a crossfade. The whole character is a single inline SVG whose expression is
driven by CSS custom properties, so the states differ *only* in the values fed to shared
geometry — "same character, different expression" holds by construction rather than by
discipline.

The decision was then tested rather than left to taste. Three profiling runs of five rapid
sends each:

| | idle control | 5 sends, transitions on | 5 sends, transitions off |
|---|---|---|---|
| React commits | 1 | 21 | 21 |
| commit median | 2.500 ms | **0.400 ms** | 0.300 ms |
| median frame interval | 16.70 ms | 16.70 ms | 16.70 ms |
| p95 frame interval | 16.80 ms | **33.30 ms** | 16.80 ms |
| long tasks > 50 ms | 0 | 0 | 1 |

The third column is an ablation: `prefers-reduced-motion` emulated, so the transitions
collapse to 1ms while React does the *identical* 21 commits. p95 returns to baseline,
which locates the cost in `fill`/`stroke` repaint rather than React overhead.

That closes the Framer Motion question properly instead of leaving it unfired. The
transitions do cost a little frame time — and the same measurement shows an animation
runtime would not have recovered it, because the cost is not React. Render cost is
**0.400ms median against a 16.7ms budget**, and no long task is attributable to the
avatar.

### A latent frontend bug the avatar would have exposed

`pollAnalysis` abandons a message permanently on a single failed fetch: the `catch`
returns without rescheduling and without moving `analysis_status` off `pending`. That had
been harmless because nothing rendered `pending` — the avatar renders it as a spinner,
so a momentary network blip would have become a permanent one on screen.

Step 6 contains the symptom with a 3s client-side deadline, chosen for margin over the
measured 422–638ms window. It was verified against the real bug rather than a mock:
serving the frontend from an origin outside `CORS_ORIGINS` makes the request genuinely
fail, and the avatar sat at `analyzing` through +2849ms and reverted to `idle` by
+3364ms. A real result arriving late (+4013ms, `mood=frustrated`) left the avatar on
`idle`, and the next message animated normally — the deadline is keyed on message id, so
it suppresses one stale result rather than freezing the avatar.

**The root cause is deliberately still open.** A retry policy belongs to the poll loop,
not to a presentation phase, and it is recorded as its own change in
[`docs/progress.md`](progress.md). "Step 6 done" does not mean `pollAnalysis` is fixed.

---

## 10. Every measured number

All from real runs on the development machine — a Windows laptop concurrently running
Postgres, Redis, uvicorn and the ARQ worker.

### Latency

| Operation | Value |
|---|---|
| `POST /messages`, server-side | 27–42ms (median 41.1ms over 24 sends, p95 85.8ms) |
| `POST /messages`, Phase 3 observed | 19–46ms |
| End-to-end, send → `complete` | 422–638ms |
| Local multilingual inference | **median 40.0ms**, min 27.8, p95 49.4, max 56.1 |
| Local lexicon fallback | **median 0.014ms**, p95 0.026ms (n=1000) |
| Redis cache hit | median 1.085ms, p95 1.697ms (n=200) |
| Circuit breaker, OPEN short-circuit | 3.87–6.72ms vs 3008–3014ms CLOSED |
| Gemini, healthy, `thinking_level="low"` | median 1410ms, 5/5 under 2s |
| Gemini, default thinking level | 6.0–12.6s, 0/5 under 2s, one 30s timeout |
| Gemini, after recovery (2026-07-28) | 2050–2154ms |
| Model cold load, idle machine | 8.22s standalone, 7078ms in worker |
| Model cold load, **real working set** | **27.6–34.0s** (33.9s online vs 24.9s `HF_HUB_OFFLINE=1`) |
| API boot-to-ready, model loaded eagerly | 32.1–34.2s |

### Accuracy

| Measure | Value |
|---|---|
| Language detection, fixtures | 45/45 |
| Language detection, **held-out real messages** | **6/6** |
| `langdetect` alone, for comparison | 30/45 (0/15 on Hinglish) |
| Mood, 4-way exact match | 32/45 (71.1%) |
| Mood, lexicon disabled | 30/45 |
| Polarity (model only) | 41/45 (91.1%) |
| Cache hit rate, realistic traffic | 37.5% (9 hits / 24 sends, 12 unique) |

### Scale

| | |
|---|---|
| Commits | 19 across Phases 1–3; Phase 4 uncommitted at time of writing |
| Tests | 33 passing, all backend (Phase 4 adds none — see §14; Phase 5 adds 12) |
| Application code | 3,825 lines (Python + TypeScript) |
| Documentation | ~21,000 words across 8 documents |
| Evaluation corpus | 45 hand-written messages |
| Alembic migrations | 4 |

---

## 11. Testing strategy

**33 tests in four suites**, all exercising real Postgres and real Redis rather than
mocks — because the properties under test (atomicity, shared state, persistence) are
properties *of* those systems, and a mock would only assert that the mock works.

**All 33 are backend.** The frontend has no test runner configured, so Phase 4's avatar
is covered by captured evidence — scripted runs against the live backend, reading state
from the DOM rather than from a screenshot — rather than by assertions that re-run. That
is weaker and is listed as a limitation in §14.

### `test_failure_injection.py` — 5 tests

Proves the pipeline degrades instead of breaking:

- three consecutive failures open the circuit
- with the circuit open, a message is still analysed and never stalls
- **no message is ever left `pending`** — the load-bearing guarantee
- persistence survives total analysis failure (even the fallback is forced to explode)
- a repeated message does not produce a second API call

### `test_multilingual_cache_keys.py` — 6 tests

Devanagari and its Hinglish transliteration must not share a cache key. The current
implementation cannot collide — the key is a SHA-256 over normalised text. The risk being
guarded is a *future* change: transliteration folding or Unicode compatibility
normalisation is exactly what someone adds later to lift the hit rate, and either would
silently merge the two.

The justification turned out to be empirical rather than theoretical. The same sentence in
both scripts produces **identical toxicity (0.85) but different heat scores — 0.75 versus
0.44**. They are genuinely scored differently, so merging their cache entries would serve
a materially wrong answer.

### `test_multilingual_regression.py` — 10 tests

The full corpus through detect → analyze → cache, with **per-category floors**:

| category | measured | floor | margin |
|---|---|---|---|
| calm | 8/9 | 7/9 | +1 |
| neutral | 9/9 | 8/9 | +1 |
| frustrated | 9/12 | 8/12 | +1 |
| **angry** | 6/15 | **6/15** | **0** |
| overall | 32/45 | 30/45 | +2 |

This design replaced a single aggregate assertion at 32/45 with zero margin, which had two
defects: it could not distinguish "the analyzer got strictly worse" from "one category
traded against another", and on failure it said nothing about *which* capability broke.

The overall floor sits at 30 deliberately — at 32 the aggregate would bind before any
category floor could fire, reinstating the brittleness; at 29 (the exact sum of the
floors) it could never fail independently. At 30 it catches **broad shallow degradation**
that no single category floor would notice.

**The test was then verified by deliberately breaking the code**, because a test that has
never failed is not known to work:

```
    angry        5/15  floor 6/15  margin -1     <- caught, failed
    OVERALL     31/45  floor 30/45 margin +1     <- PASSED

E   AssertionError: angry accuracy 5/15 fell below floor 6/15 - regression in
    low-affect anger detection (this category has zero margin by design).
```

The aggregate passed while the product's most important capability was broken. Only the
category floor caught it — the redesign justifying itself on real output rather than
argument. The injection was then reverted, verified byte-identical by diff.

---

## 12. Engineering practices this project demonstrates

**Measure before deciding.** The asynchronous architecture exists because Gemini was
benchmarked first and found to have a 1410ms median against a 2s budget. ONNX conversion
was rejected on measured 40ms latency, not on a guess.

**Write the target down before writing the code.** Phase 2 opened with an SLO document.
Phase 3's one iteration had its pass criterion committed to the results file *before the
model finished downloading*, along with a prediction of the outcome — so the write-up
could not be reverse-engineered from the result.

**Distrust your own favourable numbers.** Language detection scored 45/45 and was
explicitly not believed, because the heuristic had been written after seeing the fixtures.
It was re-validated against held-out real messages. Mood accuracy was reported as three
numbers rather than one, specifically to expose how much of it came from a hand-written
lexicon rather than the model.

**Prefer the honest number to the flattering one.** The earlier 30-message corpus scored
83%. Expanding it and removing self-authored vocabulary from the heated samples dropped it
to 71%. The 71% is reported, and the reason for the drop documented.

**Test the test.** Regression floors were validated by injecting a real regression and
confirming the correct assertion failed with a message naming the category.

**Documentation as a first-class artifact.** ~21,000 words, every claim backed by pasted
output, including a "gotchas discovered the hard way" section so that debugging time is
spent once, and a [prompts record](prompts.md) covering both the prompts the application
sends and the briefs used to build it.

**Honest scoping.** The scope document states plainly that sarcasm and manipulation
detection are out of scope and that nothing in the numbers speaks to them — a real gap in
a product whose thesis touches manipulative communication, recorded rather than left
unstated.

---

## 13. Hard problems solved

### The lexicon was marking its own homework

Mid-project audit found that four `angry` fixtures contained words from the analyzer's own
escalation lexicon (`pathetic`, `बकवास`, `bakwas`, `bewakoof`). All four were graded
correct — by keyword lookup, not by the model.

The consequence was worse than inflated scores. On two of them the model's own opinion was
`p_neg` of 0.50 and **0.38** — it did not consider them negative at all. **The lexicon was
concealing a genuine Hinglish weakness**, which is the opposite of what the iteration step
exists to find.

Fixed two ways: a `use_lexicon=False` measurement flag so the model's unaided contribution
is always reportable, and 15 new heated fixtures written to contain none of the lexicon's
vocabulary, expressing anger through finality and withdrawal instead.

### A production bug found by a database the scripts never touched

Wiring the new analyzer into the worker produced:

```
StringDataRightTruncationError: value too long for type character varying(16)
[parameters: ('complete', 'multilingual_local', ...)]
```

`analysis_source` was `varchar(16)`; `multilingual_local` is 18 characters. This would
have failed on **every message in production**, surfacing as a worker crash that left rows
stuck in `pending` — precisely the failure Phase 2 exists to prevent.

The evaluation scripts never touched Postgres and could not have caught it. Only the tests
that use the real database did. Fixed with a migration, widened to 32 so the next analyzer
name does not need another one.

### A frontend that rendered Hindi by luck

The CSS font stack — Inter, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI —
contains **no Devanagari glyphs between them**. Hindi rendered only through the browser's
implicit last-resort fallback: not guaranteed, not consistent across platforms, and tofu
boxes on any machine without a Devanagari font installed.

Fixed by naming OS-bundled faces explicitly (Nirmala UI, Noto Sans Devanagari, Devanagari
Sangam MN), with no webfont — a network fetch to render a message the user already typed
is the wrong trade. Verified by walking the font stack's cmap tables *and* by rasterising
the text and visually inspecting the conjuncts, because a font can advertise a codepoint
and still draw it badly.

### Two contaminated test runs

End-to-end verification twice returned `source=gemini` despite Gemini being disabled.
First cause: a **stale ARQ worker from an earlier session** still consuming the same Redis
queue with pre-Phase-3 code. Second cause, after killing it: **the cache**, still serving
the contaminated results — given away by suspiciously fast 215–426ms completions against a
real path taking ~630ms. Both are hazards of testing against live shared infrastructure,
and both are now recorded in the gotchas list.

### Platform friction, documented so it is solved once

- Windows console is cp1252 and **cannot print Devanagari** — any script printing Hindi
  dies with `UnicodeEncodeError` before showing a single result.
- Hugging Face downloads need `HF_HUB_DISABLE_SYMLINKS=1` on Windows without Developer
  Mode, or die mid-file with `WinError 1314`; a resume-and-retry fetch script was written
  after downloads stalled silently at 346MB.
- Nirmala UI ships as `Nirmala.ttc`, not `.ttf`.
- Segoe UI carries 10 stray Devanagari codepoints — enough to make a naive "first font
  with any Devanagari" check select a face that renders nothing legible.
- `localhost` costs ~2s per request from Python on Windows (IPv6 resolution first, then
  fallback); use `127.0.0.1` in test scripts.

---

## 14. Known limitations, stated plainly

**`angry` detection is 6/15.** The most product-relevant category is the weakest. Cause
diagnosed, one bounded fix attempted and failed, documented rather than forced. This is
the honest headline weakness.

**Mood accuracy clears its threshold narrowly.** 32/45 is 71.1% against a 70% bar. It
should never be reported as "passes" without that qualifier.

**The frustrated/angry boundary rests on unvalidated thresholds.** `p_neg >= 0.80` and
friends were chosen by judgement before the corpus existed. Tuning them against the
45-message corpus was explicitly rejected — it would produce a fit reported as a
measurement.

**Cross-language content is not controlled.** Categories are thematically similar but not
the same message translated. If Hindi scores worse than English, this corpus cannot
distinguish a real capability gap from the Hindi example simply being milder.

**Single-message analysis only.** "Forget it" is unremarkable alone and severe as the
fourth reply in a thread. Nothing here models conversational context, which structurally
prevents detecting escalation.

**No sarcasm or manipulation-pattern detection.** Explicitly out of scope; nothing in the
numbers speaks to it either way.

**The chosen model's license is inferred, not declared.** The model card states none; the
Apache-2.0 finding comes from the authors' source repository. Fine for a personal build,
unresolved for a commercial one.

**~~The frontend renders `mood` only.~~ Closed by Phase 5.** The `NudgeBanner` added in
Phase 5 renders `heat_score` (above a threshold of 0.35) and uses `rewrite_suggestion` as
its body text — the part that tells a sender *what* makes a message land hard.
`toxicity_score` remains fetched and undisplayed, deliberately: it measures cruelty
rather than escalation, and the banner is about escalation.

**The nudge threshold is not held-out.** 0.35 was chosen by sweeping the same 45-message
corpus this document already calls small, so it inherits every one of that corpus's
limitations. It was deliberately *not* set to the fitted optimum of 0.23 — whose margin
over the highest-scoring calm fixture is a single fixture — and it is biased to
under-warn, firing on 15 of 27 heated fixtures and none of the 18 calm ones. Real typing
will not separate as cleanly as a corpus whose calm messages are unambiguously calm.

**Phase 4 has no automated tests.** Its evidence is real — scripted runs against the live
backend, with state read from the DOM rather than from screenshots — but it is captured
evidence, not a suite that runs in CI. A regression in the avatar's mood mapping or its
3s deadline would not be caught by `pytest`. The pure functions (`resolveAvatarState`,
and the deadline logic in `useAvatarState`) were written to be testable for exactly this
reason, but the frontend has no test runner configured at all, which is the real gap.

**`pollAnalysis` abandons a message on a single failed fetch.** In `useChat.ts` the
`catch` around `getAnalysis` logs and returns without rescheduling the next tick and
without moving `analysisStatus` off `pending`, so one transient network error strands
that message for the session. Invisible today because nothing renders `pending`. The real
fix is a bounded retry with backoff in the poll loop.

**Two latent bugs in the dormant Gemini prompt.** It frames the sender and recipient as
being "in a close relationship", contradicting the any-two-people scope; and its open
mood vocabulary (`warm`, `hurt`, `playful`…) is incompatible with the four labels
`multilingual_local` emits. Neither affects anything today because the prompt is disabled,
but both bite the moment `GEMINI_ENABLED=true`. Detail in [prompts.md](prompts.md).

**Corpus size.** 45 messages is small. Per-category confidence intervals are wide.

---

## 15. Roadmap

Phase 4 is done — see [section 9](#9-phase-4--the-avatar-layer). What remains:

**Conversational context.** The single largest accuracy lever available, and the one that
would directly attack the `angry` weakness — escalation is a property of a thread, not a
message.

**A model trained on interpersonal conflict** rather than social-media toxicity. The
target concept is contempt and withdrawal — closer to Gottman's Four Horsemen than to
content moderation. Step 5 established that no off-the-shelf toxicity model covers this.

**Re-evaluate Gemini.** It recovered on 2026-07-28 (verified, 2050–2154ms) and remains
config-gated off. Turning it on is `GEMINI_ENABLED=true` — a config flip, by design.
The open question is whether accuracy that has never been measured on this corpus should
displace accuracy that has, at 50× the latency.

**~~Surface the rewrite suggestion.~~ Done in Phase 5**, as the body text of the new
`NudgeBanner`. A banner that said only "this reads as heated" would be a verdict with no
reasoning attached, which is the thing the product exists not to be.

**Fix the poll loop's retry behaviour.** Phase 4 contained the symptom of
`pollAnalysis` abandoning a message on a transient fetch error; the cause is untouched
and wants a bounded retry with backoff.

**A frontend test runner.** There is none, which is why Phase 4 shipped with captured
evidence instead of assertions.

**~~Later phases: a browser extension.~~ Built in Phase 5 as a proof of concept** — a
Manifest V3 extension for WhatsApp Web, read-only, unpublished and undistributed. Scope
and evidence in [`phase5-scope.md`](phase5-scope.md). Three of its DONE WHEN criteria
need a logged-in browser session and are still outstanding; the substantive one is
whether its selectors match today's real WhatsApp DOM, which no local test can answer.

---

## 16. Interview talking points

### The 60-second version

> StillWithYou analyses the emotional tone of a message before it's sent and warns the
> sender if it'll land harder than they intend — across English, Hindi and Hinglish. It's
> FastAPI, Postgres, Redis and a local transformer model, with an async job queue and a
> circuit breaker so a third-party outage can never lose a message. The part I'd actually
> want to talk about is the measurement discipline: I found that my accuracy numbers were
> partly measuring my own hand-written lexicon rather than the model, rebuilt the test
> corpus to eliminate that, and watched the headline number drop from 83% to 71%. The 71%
> is the one I report.

### Likely questions, with honest answers

**"Why is accuracy only 71%?"**
> Because that's the number after removing the contamination that made it 83%. Four of six
> "angry" samples in my original corpus contained words from my own lexicon, so they were
> graded by keyword lookup rather than by the model. When I rewrote them to express anger
> through withdrawal instead of insults, the model couldn't detect it. The failure is
> concentrated in one category — `angry`, at 6/15 — and the cause is that a polarity model
> can't see cold contempt. "Forget it, I'm done asking you for anything" isn't
> linguistically negative, but it's one of the more serious things you can say to someone.

**"Why didn't you fix it?"**
> I tried exactly one bounded fix and pre-registered the pass criterion before running it:
> an independent toxicity classifier had to recover at least 5 of the 9 missed cases. It
> recovered zero. Seven of the nine scored below 0.07 toxicity, and the *most* toxic thing
> in my whole corpus according to that model was a message telling a friend to go to sleep
> because they were tired. Both models are proxies for loud negativity; the missing
> capability is quiet anger. Forcing it would have meant tuning thresholds against my own
> test set, which produces a fit you then report as a measurement.

**"How do you know your tests actually work?"**
> I broke the code on purpose and confirmed the right test failed. What that proved was
> more interesting than I expected — the aggregate check *passed* at 31/45 while the
> injected regression was live. Only the per-category floor caught it. An aggregate-only
> test would have shipped that.

**"How did the accuracy limitation affect the product design?"**
> It set it. `angry` is 6/15, so when I built the avatar I made the visual step from
> frustrated to angry deliberately small — about 1.6 to 1.8 times frustrated's
> displacement from neutral, measured from the rendered DOM, not eyeballed. A face that
> flashes red is the most confident medium in the product, and using it for a coin-flip
> would be lying with a picture. Then it justified itself by accident: while I was
> capturing evidence, I sent *"Forget it, I'm done asking you for anything"* — one of the
> nine angry cases the model misses — and it came back frustrated, so the avatar showed
> amber instead of clay. Nothing was broken. The interface faithfully showed an
> underestimate, which is what it should do when the model is wrong. That's the example
> I'd rather give than "we designed for honesty."

**"What was the hardest bug?"**
> A `varchar(16)` column against an 18-character value. It would have failed on every
> message in production and surfaced as a worker crash leaving rows stuck in `pending` —
> the exact failure the whole resilience layer exists to prevent. My evaluation scripts
> never touched Postgres, so they couldn't have found it. Only the tests running against
> the real database did. That's the argument for not mocking your datastore.

**"What would you do differently?"**
> Write the evaluation corpus before the analyzer. I wrote the lexicon first and then
> unconsciously wrote test messages using its vocabulary. The ordering created the
> contamination, and everything after was cleanup.

### The themes to emphasise

1. **Reliability engineering** — SLOs written before code, circuit breaker, graceful
   degradation, validated by a genuine unplanned outage.
2. **Measurement honesty** — held-out validation, ablation, pre-registration, reporting
   the unflattering number.
3. **Applied ML judgement** — model selection on tokenizer evidence and license, not
   leaderboard position; knowing when a model *cannot* do a thing and saying so.
4. **Production instincts** — real-dependency testing, migrations, observability,
   a runbook.
5. **Cultural specificity** — Hinglish is genuinely underserved, and the corpus reflects
   how people actually type rather than how transliteration guides say they should.
