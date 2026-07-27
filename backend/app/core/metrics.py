"""Prometheus metrics.

The API and the ARQ worker are separate processes, but the interesting counters
are incremented in the worker while /metrics is served by the API. Rather than run
a second exporter, counters are kept in Redis and read at scrape time, so one
endpoint reports the whole system.

Redis is the natural home for this: the circuit breaker already keeps its state
there, and a Prometheus counter is exactly an INCR.
"""

from prometheus_client import CONTENT_TYPE_LATEST, CollectorRegistry, Gauge, Histogram, generate_latest

from app.core.redis import get_redis

_COUNTER_PREFIX = "swy:metric"

# Buckets chosen around what we actually measured: a cache hit or fallback lands in
# the first two, a healthy Gemini call around 1-2s, and the 3s bucket is the
# deadline itself.
LATENCY_BUCKETS = (0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1.0, 2.0, 3.0, 5.0, 10.0)

_CIRCUIT_STATE_VALUES = {"closed": 0, "open": 1, "half_open": 2}


async def incr(metric: str, **labels: str) -> None:
    """Increment a counter. Never raises — metrics must not break the job."""
    try:
        await get_redis().hincrby(f"{_COUNTER_PREFIX}:{metric}", _label_key(labels), 1)
    except Exception:  # noqa: BLE001
        pass


async def observe_latency(seconds: float) -> None:
    """Record a Gemini call duration into Redis-backed histogram buckets."""
    try:
        redis = get_redis()
        pipe = redis.pipeline()
        for bucket in LATENCY_BUCKETS:
            if seconds <= bucket:
                pipe.hincrby(f"{_COUNTER_PREFIX}:latency_bucket", str(bucket), 1)
        pipe.hincrby(f"{_COUNTER_PREFIX}:latency_bucket", "+Inf", 1)
        pipe.hincrbyfloat(f"{_COUNTER_PREFIX}:latency_sum", "sum", seconds)
        await pipe.execute()
    except Exception:  # noqa: BLE001
        pass


def _label_key(labels: dict[str, str]) -> str:
    return ",".join(f"{k}={v}" for k, v in sorted(labels.items())) or "_"


def _parse_label_key(key: str) -> dict[str, str]:
    if key == "_":
        return {}
    out = {}
    for pair in key.split(","):
        if "=" in pair:
            name, _, value = pair.partition("=")
            out[name] = value
    return out


def _escape(value: str) -> str:
    return value.replace("\\", "\\\\").replace('"', '\\"')


async def render() -> tuple[str, str]:
    """Build the exposition payload from Redis state. Returns (body, content_type)."""
    redis = get_redis()
    lines: list[str] = []

    async def counter(metric: str, name: str, help_text: str) -> None:
        raw = await redis.hgetall(f"{_COUNTER_PREFIX}:{metric}")
        lines.append(f"# HELP {name} {help_text}")
        lines.append(f"# TYPE {name} counter")
        if not raw:
            lines.append(f"{name}_total 0")
            return
        for label_key, count in sorted(raw.items()):
            labels = _parse_label_key(label_key)
            rendered = ",".join(f'{k}="{_escape(v)}"' for k, v in labels.items())
            suffix = f"{{{rendered}}}" if rendered else ""
            lines.append(f"{name}_total{suffix} {count}")

    await counter("gemini_call", "gemini_call", "Gemini calls by outcome.")
    await counter("cache_hit", "cache_hit", "Analysis cache hits by language.")
    await counter("cache_miss", "cache_miss", "Analysis cache misses by language.")
    await counter("fallback_triggered", "fallback_triggered", "Local fallback invocations by reason.")
    # Phase 3: the analyzer that is actually serving. `language` is one of
    # en / hi / hi-en-mixed, so volume and mood distribution can be read per input
    # mode rather than as one undifferentiated total — which is what would have
    # hidden the fact that the `angry` weakness is uniform across all three.
    await counter(
        "analysis_local",
        "analysis_local",
        "Local multilingual analyses by language and mood.",
    )

    # circuit_breaker_state gauge: 0 closed, 1 open, 2 half_open
    state = await redis.get("swy:cb:gemini:state") or "closed"
    lines.append("# HELP circuit_breaker_state Circuit state: 0=closed 1=open 2=half_open.")
    lines.append("# TYPE circuit_breaker_state gauge")
    lines.append(f'circuit_breaker_state{{circuit="gemini"}} {_CIRCUIT_STATE_VALUES.get(state, 0)}')

    # Latency histogram, reassembled from the Redis buckets.
    buckets = await redis.hgetall(f"{_COUNTER_PREFIX}:latency_bucket")
    total_sum = await redis.hget(f"{_COUNTER_PREFIX}:latency_sum", "sum")
    lines.append("# HELP gemini_call_latency_seconds Gemini call duration.")
    lines.append("# TYPE gemini_call_latency_seconds histogram")
    for bucket in LATENCY_BUCKETS:
        count = buckets.get(str(bucket), 0)
        lines.append(f'gemini_call_latency_seconds_bucket{{le="{bucket}"}} {count}')
    inf_count = buckets.get("+Inf", 0)
    lines.append(f'gemini_call_latency_seconds_bucket{{le="+Inf"}} {inf_count}')
    lines.append(f"gemini_call_latency_seconds_sum {float(total_sum or 0.0)}")
    lines.append(f"gemini_call_latency_seconds_count {inf_count}")

    return "\n".join(lines) + "\n", CONTENT_TYPE_LATEST


async def reset() -> None:
    """Clear all counters. For tests."""
    redis = get_redis()
    keys = [key async for key in redis.scan_iter(match=f"{_COUNTER_PREFIX}:*")]
    if keys:
        await redis.delete(*keys)
