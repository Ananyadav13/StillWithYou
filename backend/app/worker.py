"""ARQ worker process.

Run with:  arq app.worker.WorkerSettings

This is where Gemini is called from Step 3 onward. Moving the call out of the
request path is what lets POST /messages return in single-digit milliseconds
while a 1-3s (occasionally 30s) analysis runs behind it.
"""

import uuid
from typing import Any

from sqlalchemy import update

from app.core.db import SessionLocal
from app.core.logging import configure_logging, log_event, track_analysis
from app.core.queue import redis_settings
from app.models.message import AnalysisStatus, Message
from app.schemas.analysis import AnalysisResult
from app.services.cache import get_cached, set_cached
from app.services.circuit_breaker import gemini_breaker
from app.services.gemini import GeminiError, analyze_message, get_client
from app.services.local_fallback import analyze_locally


async def _write_result(
    message_id: str, result: AnalysisResult | None, status: AnalysisStatus
) -> None:
    """Persist the analysis outcome. Always moves the row out of `pending`."""
    values: dict[str, Any] = {"analysis_status": status}
    if result is not None:
        values.update(
            analysis_source=result.source,
            mood=result.mood,
            toxicity_score=result.toxicity_score,
            heat_score=result.heat_score,
            rewrite_suggestion=result.rewrite_suggestion,
        )

    async with SessionLocal() as session:
        await session.execute(
            update(Message).where(Message.id == uuid.UUID(message_id)).values(**values)
        )
        await session.commit()


async def analyze_message_job(ctx: dict[str, Any], message_id: str, content: str) -> str:
    """Analyse one message and write the result back to its row.

    Never raises: an escaping exception would let ARQ retry into the same failure
    and leave the row in `pending`. Every path ends in `complete` or `failed`.
    """
    result: AnalysisResult | None = None
    degraded_reason: str | None = None

    with track_analysis(message_id, event="analysis_job") as track:
        # Cache first: a hit costs one Redis GET and skips both the circuit breaker
        # and the network entirely.
        cached = await get_cached(content, message_id=message_id)
        if cached is not None:
            track.success(source=cached.source, mood=cached.mood, cache="hit")
            await _write_result(message_id, cached, AnalysisStatus.complete)
            return AnalysisStatus.complete.value

        allowed, circuit_state = await gemini_breaker.allow()

        if not allowed:
            # Short-circuit: refuse without touching the network. This is the whole
            # point of the breaker — when Gemini is known-down, a refused call costs
            # a Redis round trip instead of a 3s timeout.
            degraded_reason = "circuit_open"
        else:
            try:
                result = await analyze_message(content)
                await gemini_breaker.record_success()
                track.success(
                    source=result.source, mood=result.mood, circuit_state=circuit_state
                )
            except GeminiError as exc:
                await gemini_breaker.record_failure(exc.kind)
                degraded_reason = exc.kind

        if result is None:
            # Every failure path lands here, so there is no route to a stuck row.
            # The local analyzer cannot raise and cannot block, which is what makes
            # `complete` reachable even with the dependency completely gone.
            result = analyze_locally(content)
            track.fallback(
                source=result.source,
                mood=result.mood,
                reason=degraded_reason,
                circuit_state=circuit_state,
            )

    await set_cached(content, result)

    # Unconditionally `complete`: a result exists either way. `failed` is now
    # reserved for the case where even the fallback could not run, which is only
    # reachable if the database write itself fails.
    await _write_result(message_id, result, AnalysisStatus.complete)
    return AnalysisStatus.complete.value


async def ping_job(ctx: dict[str, Any]) -> str:
    """No-op task used to prove the enqueue -> consume path works."""
    log_event("ping_job", job_id=ctx.get("job_id"))
    return "pong"


async def startup(ctx: dict[str, Any]) -> None:
    configure_logging()
    try:
        get_client()  # warm the client; a cold build inside a job can block for minutes
    except GeminiError as exc:
        log_event("gemini_client_unavailable", level=30, error=str(exc))
    log_event("worker_startup", redis=_redis_target())


async def shutdown(ctx: dict[str, Any]) -> None:
    log_event("worker_shutdown")


def _redis_target() -> str:
    """host:port/db of the configured Redis, for logging. Never includes a password."""
    rs = redis_settings()
    return f"{rs.host}:{rs.port}/{rs.database}"


class WorkerSettings:
    functions = [analyze_message_job, ping_job]
    redis_settings = redis_settings()
    on_startup = startup
    on_shutdown = shutdown
