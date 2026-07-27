"""ARQ worker process.

Run with:  arq app.worker.WorkerSettings

Step 2 wanted an empty functions list, but ARQ refuses to construct a worker that
has nothing registered ("at least one function or cron_job must be registered"),
so `ping_job` stands in as a liveness probe. It also earns its place: enqueueing
it is the cheapest end-to-end check that the API and the worker share a Redis.
Step 3 adds the real analyze_message_job alongside it.
"""

from typing import Any

from app.core.logging import configure_logging, log_event
from app.core.queue import redis_settings


async def ping_job(ctx: dict[str, Any]) -> str:
    """No-op task used to prove the enqueue -> consume path works."""
    log_event("ping_job", job_id=ctx.get("job_id"))
    return "pong"


async def startup(ctx: dict[str, Any]) -> None:
    configure_logging()
    log_event("worker_startup", redis=_redis_target())


async def shutdown(ctx: dict[str, Any]) -> None:
    log_event("worker_shutdown")


def _redis_target() -> str:
    """host:port/db of the configured Redis, for logging. Never includes a password."""
    rs = redis_settings()
    return f"{rs.host}:{rs.port}/{rs.database}"


class WorkerSettings:
    functions = [ping_job]
    redis_settings = redis_settings()
    on_startup = startup
    on_shutdown = shutdown
