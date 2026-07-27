# Phase 2 — Reliability target for message analysis

Scope: the Gemini-backed mood/toxicity analysis attached to each chat message.
This document defines what "working" means numerically, and what we do when it
isn't. Everything downstream in Phase 2 (circuit breaker, local fallback, cache,
metrics) exists to hold the numbers below.

## SLI

**Analysis freshness:** the percentage of message sends that receive a
mood/toxicity result within **2 seconds** of the send being accepted.

Measured from the moment `POST /messages` returns 201 to the moment the message's
`analysis_status` becomes `complete`. A result counts whether it came from Gemini,
from the cache, or from the local fallback — the user cares that the analysis
arrived, not which engine produced it.

**Send durability:** the percentage of accepted sends whose message row is
persisted, regardless of what the analysis path did.

## SLO

| # | Objective | Target |
|---|-----------|--------|
| 1 | Sends receiving an analysis result within 2s | **95%** |
| 2 | Sends whose message is persisted regardless of Gemini's state | **99.9%** |

Objective 2 is the load-bearing one. Objective 1 may degrade to a lower-fidelity
answer under failure; objective 2 may not degrade at all. A message the user typed
is never lost because a third-party API was unavailable.

## Measured baseline (2026-07-27, before any Phase 2 work)

Real numbers from the current API key, five representative messages per run:

| Condition | Result |
|-----------|--------|
| `gemini-2.0-flash`, `gemini-2.0-flash-lite`, `gemini-2.5-pro` | Unusable — quota `limit: 0`, every call 429 |
| `gemini-3.5-flash-lite`, default thinking level | 6.0s / 9.2s / 9.9s / 12.6s / one 30s timeout — **0/5 under 2s** |
| `gemini-3.5-flash-lite`, `thinking_level="low"` | 1.0s / 1.3s / 1.4s / 1.7s / 1.8s — median 1410ms, **5/5 under 2s** |
| Same config, a later run | 1.1s / 1.1s / 1.3s / 1.7s / 3.2s — **4/5 under 2s** |

Two things follow, and they set the whole design:

1. The 2s SLO is achievable but has almost no headroom. A median of ~1.4s against
   a 2s budget means ordinary server-side variance breaches it, and we observed
   exactly that — an identical config produced a 3.2s call in one run and a 30s
   timeout in another.
2. Therefore analysis **cannot** sit in the request path. Objective 2 at 99.9%
   is incompatible with waiting on a dependency whose tail we do not control.

## Failure modes and handling

One line each; the implementation detail lives in the step that builds it.

| Mode | Detection | Handling |
|------|-----------|----------|
| **Gemini 429 (rate limit)** | `ClientError` with `code == 429` → `GeminiError(kind="rate_limit")` | Counts as a circuit-breaker failure; serve the local fallback result rather than retrying into a quota wall. |
| **Gemini 5xx** | `ServerError` / `code` in 500-599 → `kind="server_error"` | Counts as a circuit-breaker failure; one retry at most, then local fallback. |
| **Gemini timeout (>3s)** | `asyncio.wait_for` ceiling in `analyze_message` → `kind="timeout"` | Cancel the call at our deadline, count as a breaker failure, fall back locally — never let a slow call hold a job open. |
| **Malformed / unparseable response** | Empty body, bad JSON, or schema-invalid payload → `kind="malformed"` | Never persist a partial analysis; treat as a failure and fall back locally so the message still reaches `complete`. |

All four converge on the same contract: **the message always ends in
`analysis_status = complete` or `failed`, never stuck in `pending`.**

## Persistence is not coupled to Gemini — confirmed in code

The Phase 1 handler commits the message before Gemini is touched, and wraps the
analysis call so no Gemini failure can propagate to the client.

`backend/app/routers/chat.py`, `create_message`:

```python
message = Message(content=payload.content, sender=payload.sender)
session.add(message)
await session.commit()          # <- durable here, unconditionally
await session.refresh(message)

analysis = None
try:
    analysis = await analyze_message(message.content)
except GeminiError:
    analysis = None             # <- worst case is 201 with analysis: null
```

Two properties this gives us, both of which Phase 2 must preserve:

- The commit is unconditional and happens first. No Gemini outcome can roll it back.
- `GeminiError` is caught at the boundary, so a 429/5xx/timeout/malformed response
  degrades the response body, never the status code and never the stored row.

The ORM model reinforces this: `backend/app/models/message.py` carries no
Gemini-derived columns, so a message row is complete and valid the instant it is
written. Analysis columns added in Step 3 are all nullable for the same reason.

**What Step 3 changes:** the synchronous `await analyze_message(...)` above moves
into an ARQ job. That strengthens the guarantee rather than weakening it — after
Step 3 the request path does not call Gemini at all, so Gemini latency stops
contributing to send latency entirely. The `try/except` contract stays, relocated
to the worker.
