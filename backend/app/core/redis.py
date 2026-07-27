"""Shared async Redis client.

Separate from the ARQ pool in core/queue.py: that one is owned by the job broker,
this one holds circuit-breaker and cache state. Same server, different concerns.
"""

import redis.asyncio as aioredis

from app.core.config import settings

_client: aioredis.Redis | None = None


def get_redis() -> aioredis.Redis:
    """Process-wide Redis client. decode_responses so callers deal in str, not bytes."""
    global _client
    if _client is None:
        _client = aioredis.from_url(settings.redis_url, decode_responses=True)
    return _client


async def close_redis() -> None:
    global _client
    if _client is not None:
        await _client.aclose()
        _client = None
