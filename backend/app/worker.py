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
from app.services.gemini import GeminiError, analyze_message, get_client


async def _write_result(
    message_id: str, result: AnalysisResult | None, status: AnalysisStatus
) -> None:
    """Persist the analysis outcome. Always moves the row out of `pending`."""
    values: dict[str, Any] = {"analysis_status": status}
    if result is not None:
        values.update(
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
    status = AnalysisStatus.failed

    with track_analysis(message_id, event="analysis_job") as track:
        try:
            result = await analyze_message(content)
            status = AnalysisStatus.complete
            track.success(source=result.source, mood=result.mood)
        except GeminiError as exc:
            track.error(failure_kind=exc.kind, error=str(exc)[:200])

    await _write_result(message_id, result, status)
    return status.value


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
