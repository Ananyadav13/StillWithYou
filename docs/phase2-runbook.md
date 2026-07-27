# Phase 2 runbook

Lookup table for the analysis pipeline. Find the symptom, run the checks in order.

Dashboards: `/metrics` on the API, Prometheus at <http://localhost:9090>.

---

## `circuit_breaker_state` is OPEN for >5 minutes

`circuit_breaker_state{circuit="gemini"} 1` continuously. Every message is being
scored by the local fallback, so users are getting degraded analysis, not none.
**This is not user-facing downtime** — do not page for it out of hours.

Check, in order:

1. **Gemini API status** — <https://status.cloud.google.com/> and
   <https://ai.google.dev/gemini-api/docs>. If Google is down, stop; the fallback
   is doing its job.
2. **API key validity** — `gemini_call_total{outcome="rejected"}` climbing means a
   key is being refused. Verify at <https://aistudio.google.com/apikey>. A key whose
   project was disabled returns `403 "Your project has been denied access"` — that
   needs Google support, not a retry.
3. **Quota** — `gemini_call_total{outcome="rate_limit"}` climbing means quota
   exhaustion. Check <https://ai.dev/rate-limit>. Note that a free-tier key can
   report `limit: 0` for a model it simply has no allocation for, which looks like
   throttling but is permanent for that model. Try `GEMINI_MODEL` first.
4. **Our own deadline** — if `gemini_call_total{outcome="timeout"}` dominates while
   Google is healthy, the model may just be slower than our 3s ceiling. Compare
   `gemini_call_latency_seconds` buckets. Raising `GEMINI_TIMEOUT_SECONDS` trades
   SLO compliance for success rate; changing `GEMINI_MODEL` is usually better.

To force a recovery attempt without waiting out the 60s window:

```python
from app.services.circuit_breaker import gemini_breaker
await gemini_breaker.reset()
```

## `cache_hit_total` is 0 after significant traffic

1. **Redis reachable?** `docker compose ps redis` and `docker exec
   stillwithyou-redis-1 redis-cli ping` → expect `PONG`. Look for `cache_error`
   events in the logs; cache failures are swallowed by design and will not show up
   as errors anywhere else.
2. **Are the keys actually there?** `docker exec stillwithyou-redis-1 redis-cli
   --scan --pattern 'swy:analysis:*' | head`. Empty means writes are failing;
   populated means lookups are missing.
3. **TTL expectations.** Gemini results live 3600s but **local_fallback results
   live only 60s** (`FALLBACK_TTL_SECONDS`). During a Gemini outage a low hit rate
   is correct and deliberate — caching degraded answers for an hour would turn a
   one-minute outage into a one-hour one.
4. **Traffic actually duplicated?** Keys are a SHA-256 of case- and
   whitespace-normalized text. Different punctuation is a different key.

## Messages stuck in `analysis_status = pending`

This should be unreachable — the job writes `complete` on every path, including
when both Gemini and the circuit are down.

1. **Is a worker running?** `arq app.worker.WorkerSettings`. With no worker, jobs
   queue in Redis and nothing transitions. This is the overwhelmingly likely cause.
2. **Did the enqueue fail?** Look for `analysis_enqueue_failed` in the API log.
   The message is saved and left pending by design when Redis is unreachable.
3. **Backlog?** `docker exec stillwithyou-redis-1 redis-cli LLEN arq:queue`.
4. Re-drive by re-enqueuing `analyze_message_job` with the message id and content.

```sql
SELECT id, created_at FROM messages
WHERE analysis_status = 'pending' AND created_at < now() - interval '5 minutes';
```

## A burst of traffic produced more Gemini calls than the breaker should allow

Expected, and worth understanding before "fixing" it. ARQ runs jobs concurrently
(`max_jobs`, default 10). The breaker trips *after* N failures; it does not cap
in-flight calls. A burst of 7 duplicate sends measured 7 Gemini calls and 0 cache
hits, because all 7 jobs called `allow()` and read the cache before the first
result was recorded.

Mitigations, in increasing order of cost:

- Lower `max_jobs` in `WorkerSettings` — simplest, reduces throughput.
- Single-flight: hold a short Redis lock per content hash so duplicate work
  collapses onto one call.
- Accept it. The overshoot is bounded by `max_jobs`, and every overshooting call
  still falls back correctly.

## Everything looks healthy but analysis quality dropped

Check `analysis_source` on recent rows. A run of `local_fallback` means the
circuit was open — the lexicon scorer is deliberately blunt and will miss
sarcasm and context.

```sql
SELECT analysis_source, count(*) FROM messages
WHERE created_at > now() - interval '1 hour' GROUP BY 1;
```
