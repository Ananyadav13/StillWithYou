"""ARQ worker process.

Run with:  arq app.worker.WorkerSettings

This is where Gemini is called from Step 3 onward. Moving the call out of the
request path is what lets POST /messages return in single-digit milliseconds
while a 1-3s (occasionally 30s) analysis runs behind it.
"""

import asyncio
import time
import uuid
from typing import Any

from sqlalchemy import update

from app.core.config import settings
from app.core.db import SessionLocal
from app.core.logging import configure_logging, log_event, track_analysis
from app.core.metrics import incr, observe_latency
from app.core.queue import redis_settings
from app.models.message import AnalysisStatus, Message
from app.schemas.analysis import AnalysisResult
from app.services.cache import get_cached, set_cached
from app.services.circuit_breaker import gemini_breaker
from app.services.gemini import GeminiError, analyze_message, get_client
from app.services.language_detect import detect_language
from app.services.local_fallback import analyze_locally  # noqa: F401 - last-resort path
from app.services.multilingual_local import analyze_multilingual, warm as warm_multilingual


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

    # Detected once and carried through as a metric label, so /metrics can answer
    # "how does accuracy and volume differ across en / hi / hi-en-mixed" rather than
    # reporting one undifferentiated total. Pure string work, no model involved.
    language = detect_language(content)

    with track_analysis(message_id, event="analysis_job") as track:
        # Cache first: a hit costs one Redis GET and skips both the circuit breaker
        # and the network entirely.
        cached = await get_cached(content, message_id=message_id)
        if cached is not None:
            await incr("cache_hit", language=language)
            track.success(
                source=cached.source, mood=cached.mood, cache="hit", language=language
            )
            await _write_result(message_id, cached, AnalysisStatus.complete)
            return AnalysisStatus.complete.value

        await incr("cache_miss", language=language)

        # Gemini primary path blocked as of 2026-07-27, see docs/progress.md —
        # multilingual_local serving as primary until resolved.
        #
        # Gemini stays the nominal primary: it is still the branch guarded by the
        # circuit breaker, still the only thing that records breaker successes and
        # failures, and still the first analyzer consulted. Only `gemini_enabled`
        # gates it. Flipping that setting to true restores the Phase 2 behaviour
        # exactly, with no code change here — which is the point, because the block
        # is a Google-side project permission problem that may lift without warning.
        circuit_state = await gemini_breaker.state()
        if not settings.gemini_enabled:
            degraded_reason = "gemini_disabled"
        else:
            allowed, circuit_state = await gemini_breaker.allow()
            if not allowed:
                # Short-circuit: refuse without touching the network. This is the whole
                # point of the breaker — when Gemini is known-down, a refused call costs
                # a Redis round trip instead of a 3s timeout.
                degraded_reason = "circuit_open"
            else:
                started = time.perf_counter()
                try:
                    result = await analyze_message(content)
                    await observe_latency(time.perf_counter() - started)
                    await incr("gemini_call", outcome="success")
                    await gemini_breaker.record_success()
                    track.success(
                        source=result.source,
                        mood=result.mood,
                        circuit_state=circuit_state,
                        language=language,
                    )
                except GeminiError as exc:
                    await observe_latency(time.perf_counter() - started)
                    await incr("gemini_call", outcome=exc.kind)
                    await gemini_breaker.record_failure(exc.kind)
                    degraded_reason = exc.kind

        if result is None:
            await incr("fallback_triggered", reason=degraded_reason or "unknown")
            # Every failure path lands here, so there is no route to a stuck row.
            #
            # Two analyzers sit behind this, in order. `analyze_multilingual` is the
            # active one: it handles en / hi / hi-en-mixed and costs ~40ms on CPU.
            # It cannot raise — a model failure degrades internally to the Phase 2
            # lexicon — so `complete` stays reachable with every dependency gone,
            # which is the property Phase 2 exists to guarantee and Phase 3 must not
            # weaken.
            result = await asyncio.to_thread(analyze_multilingual, content)
            await incr("analysis_local", language=language, mood=result.mood)
            track.fallback(
                source=result.source,
                mood=result.mood,
                reason=degraded_reason,
                circuit_state=circuit_state,
                language=language,
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

    if settings.gemini_enabled:
        try:
            get_client()  # warm the client; a cold build inside a job can block for minutes
        except GeminiError as exc:
            log_event("gemini_client_unavailable", level=30, error=str(exc))

    # Same reasoning, applied to the analyzer that is actually serving. Loading the
    # weights costs ~8s and the first inference another ~470ms against a ~40ms steady
    # state; paying that once at startup keeps it out of the first user's message.
    # Off the event loop, because the load is synchronous and CPU-bound.
    started = time.perf_counter()
    try:
        await asyncio.to_thread(warm_multilingual)
        log_event(
            "multilingual_model_loaded",
            load_ms=round((time.perf_counter() - started) * 1000, 1),
        )
    except Exception as exc:  # noqa: BLE001 - a failed warm must not stop the worker
        # Not fatal: analyze_multilingual degrades to the Phase 2 lexicon internally,
        # so messages still reach `complete`. Loud, though — it means every message is
        # being scored by the English-only heuristic.
        log_event(
            "multilingual_model_unavailable",
            level=40,
            error=f"{type(exc).__name__}: {exc}"[:200],
        )

    log_event(
        "worker_startup",
        redis=_redis_target(),
        gemini_enabled=settings.gemini_enabled,
        active_analyzer="gemini" if settings.gemini_enabled else "multilingual_local",
    )


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
