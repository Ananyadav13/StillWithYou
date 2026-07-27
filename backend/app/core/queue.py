"""ARQ / Redis connection plumbing.

One place that knows how to turn `settings.redis_url` into ARQ's RedisSettings,
used by both the API (which enqueues) and the worker (which consumes), so the two
can never drift onto different Redis instances.
"""

from arq import create_pool
from arq.connections import ArqRedis, RedisSettings

from app.core.config import settings

ANALYSIS_QUEUE = "arq:queue"

_pool: ArqRedis | None = None


def redis_settings() -> RedisSettings:
    """ARQ connection settings derived from the single configured DSN."""
    return RedisSettings.from_dsn(settings.redis_url)


async def get_pool() -> ArqRedis:
    """Return the process-wide enqueue pool, creating it on first use."""
    global _pool
    if _pool is None:
        _pool = await create_pool(redis_settings())
    return _pool


async def close_pool() -> None:
    """Close the enqueue pool. Called from the API's lifespan shutdown."""
    global _pool
    if _pool is not None:
        await _pool.aclose()
        _pool = None
