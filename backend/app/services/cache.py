"""Redis cache for analysis results, keyed on normalized message content.

Two messages with the same words get the same analysis, so the second one has no
reason to cost a Gemini call. In a chat app this is not a rare case: "ok", "sorry",
"i love you", "can we talk?" recur constantly, and a resend after a failure is
byte-identical by definition.

Full-fidelity and degraded results are cached with different lifetimes on purpose.
A Gemini result is good for the full hour. A local_fallback result is only held
briefly — caching a degraded answer for an hour would keep serving it long after
the circuit closed, turning a 60-second outage into a 60-minute one.
"""

import hashlib
import json
import re

from app.core.logging import log_event
from app.core.redis import get_redis
from app.schemas.analysis import AnalysisResult

TTL_SECONDS = 3600  # 1 hour, per spec, for full-fidelity Gemini results
FALLBACK_TTL_SECONDS = 60  # degraded results expire fast so recovery is visible

_WHITESPACE_RE = re.compile(r"\s+")


def normalize(content: str) -> str:
    """Fold away differences that cannot change the analysis: case and spacing."""
    return _WHITESPACE_RE.sub(" ", content.strip().lower())


def cache_key(content: str) -> str:
    """Hash rather than store the text: bounded key size, and no message bodies
    sitting in Redis in the clear."""
    digest = hashlib.sha256(normalize(content).encode("utf-8")).hexdigest()
    return f"swy:analysis:{digest[:32]}"


async def get_cached(content: str, message_id: str | None = None) -> AnalysisResult | None:
    """Return a cached result, or None. Never raises — a cache outage is not an outage."""
    key = cache_key(content)
    try:
        raw = await get_redis().get(key)
    except Exception as exc:  # noqa: BLE001
        log_event("cache_error", level=30, operation="get", error=f"{type(exc).__name__}: {exc}")
        return None

    if raw is None:
        log_event("cache_miss", message_id=message_id, key=key)
        return None

    try:
        result = AnalysisResult(**json.loads(raw))
    except (ValueError, TypeError) as exc:
        log_event("cache_corrupt", level=30, key=key, error=str(exc)[:120])
        return None

    log_event("cache_hit", message_id=message_id, key=key, source=result.source)
    return result


async def set_cached(content: str, result: AnalysisResult) -> None:
    """Store a result. Never raises."""
    ttl = TTL_SECONDS if result.source == "gemini" else FALLBACK_TTL_SECONDS
    try:
        await get_redis().set(cache_key(content), result.model_dump_json(), ex=ttl)
    except Exception as exc:  # noqa: BLE001
        log_event("cache_error", level=30, operation="set", error=f"{type(exc).__name__}: {exc}")


async def clear() -> int:
    """Drop every cached analysis. For tests and manual invalidation."""
    redis = get_redis()
    keys = [key async for key in redis.scan_iter(match="swy:analysis:*")]
    return await redis.delete(*keys) if keys else 0
