"""Failure injection: prove the pipeline degrades instead of breaking.

Requires Redis and Postgres to be up (`docker compose up -d`). It exercises the
real breaker against real Redis rather than a mock, because the property under
test — that state is shared and atomic — is a property of Redis, and a mock would
assert only that the mock works.

Gemini itself is stubbed. We need failures on demand, and the failure modes we
care about (429, 5xx, timeout) cannot be summoned from the real API reliably.
"""

import uuid

import pytest
import pytest_asyncio
from sqlalchemy import delete, select

from app.core.db import SessionLocal
from app.core.metrics import reset as reset_metrics
from app.models.message import AnalysisStatus, Message
from app.services import cache as cache_module
from app.services.circuit_breaker import FAILURE_THRESHOLD, gemini_breaker
from app.services.gemini import GeminiError
from app.worker import analyze_message_job

pytestmark = pytest.mark.asyncio(loop_scope="session")


@pytest_asyncio.fixture(autouse=True, loop_scope="session")
async def clean_state():
    """Every test starts with a closed circuit, an empty cache and no counters."""
    await gemini_breaker.reset()
    await cache_module.clear()
    await reset_metrics()
    yield
    await gemini_breaker.reset()
    await cache_module.clear()


async def _make_message(content: str) -> str:
    async with SessionLocal() as session:
        message = Message(content=content, sender="user")
        session.add(message)
        await session.commit()
        return str(message.id)


async def _get(message_id: str) -> Message:
    async with SessionLocal() as session:
        result = await session.execute(select(Message).where(Message.id == uuid.UUID(message_id)))
        return result.scalar_one()


@pytest.fixture
def failing_gemini(monkeypatch):
    """Make every Gemini call raise, and count the attempts."""
    calls = {"count": 0}

    async def _fail(content: str):
        calls["count"] += 1
        raise GeminiError("injected failure", kind="server_error")

    monkeypatch.setattr("app.worker.analyze_message", _fail)
    return calls


async def test_three_failures_open_the_circuit(failing_gemini):
    assert await gemini_breaker.state() == "closed"

    for index in range(FAILURE_THRESHOLD):
        message_id = await _make_message(f"injected failure probe {index}")
        await analyze_message_job({}, message_id, f"injected failure probe {index}")

    assert await gemini_breaker.state() == "open"
    assert failing_gemini["count"] == FAILURE_THRESHOLD


async def test_message_still_analysed_via_fallback_once_open(failing_gemini):
    """With the circuit open, a new message is analysed locally and never stalls."""
    for index in range(FAILURE_THRESHOLD):
        message_id = await _make_message(f"trip {index}")
        await analyze_message_job({}, message_id, f"trip {index}")

    assert await gemini_breaker.state() == "open"
    calls_before = failing_gemini["count"]

    message_id = await _make_message("you never listen to me and you are being ridiculous")
    result = await analyze_message_job(
        {}, message_id, "you never listen to me and you are being ridiculous"
    )

    assert result == "complete"

    # Short-circuited: Gemini was not contacted at all.
    assert failing_gemini["count"] == calls_before

    stored = await _get(message_id)
    assert stored.analysis_status is AnalysisStatus.complete
    assert stored.analysis_source == "local_fallback"
    assert stored.mood is not None
    assert stored.toxicity_score is not None
    assert 0.0 <= stored.toxicity_score <= 1.0


async def test_no_message_is_ever_left_pending(failing_gemini):
    """The property that matters most: pending is not a terminal state."""
    message_ids = []
    for index in range(FAILURE_THRESHOLD + 3):
        content = f"message number {index} that should still get analysed"
        message_id = await _make_message(content)
        await analyze_message_job({}, message_id, content)
        message_ids.append(message_id)

    async with SessionLocal() as session:
        rows = await session.execute(
            select(Message).where(Message.id.in_([uuid.UUID(m) for m in message_ids]))
        )
        messages = rows.scalars().all()

    assert len(messages) == FAILURE_THRESHOLD + 3
    stuck = [str(m.id) for m in messages if m.analysis_status is AnalysisStatus.pending]
    assert stuck == [], f"messages left pending: {stuck}"
    assert all(m.analysis_status is AnalysisStatus.complete for m in messages)
    assert all(m.analysis_source == "local_fallback" for m in messages)


async def test_persistence_survives_total_analysis_failure(monkeypatch, failing_gemini):
    """Even if the local fallback itself explodes, the message row is untouched."""

    def _explode(content: str):
        raise RuntimeError("fallback is broken too")

    monkeypatch.setattr("app.worker.analyze_locally", _explode)

    content = "the message must survive regardless"
    message_id = await _make_message(content)

    with pytest.raises(RuntimeError):
        await analyze_message_job({}, message_id, content)

    stored = await _get(message_id)
    assert stored.content == content
    assert stored.analysis_status is AnalysisStatus.pending


async def test_cache_prevents_a_second_call(monkeypatch):
    """A repeated message must not produce a second Gemini call."""
    calls = {"count": 0}

    from app.schemas.analysis import AnalysisResult

    async def _succeed(content: str):
        calls["count"] += 1
        return AnalysisResult(
            mood="warm", toxicity_score=0.1, heat_score=0.1,
            rewrite_suggestion=None, source="gemini",
        )

    monkeypatch.setattr("app.worker.analyze_message", _succeed)

    content = "identical content for the cache test"
    first = await _make_message(content)
    await analyze_message_job({}, first, content)
    assert calls["count"] == 1

    second = await _make_message(content)
    await analyze_message_job({}, second, content)
    assert calls["count"] == 1, "second identical message should have been served from cache"

    stored = await _get(second)
    assert stored.analysis_status is AnalysisStatus.complete
    assert stored.analysis_source == "gemini"
