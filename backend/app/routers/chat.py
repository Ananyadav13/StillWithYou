from datetime import datetime, timezone
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_session
from app.core.logging import log_event
from app.core.queue import get_pool
from app.models.message import Message
from app.schemas.message import (
    AnalysisRead,
    MessageCreate,
    MessageRead,
    PingRequest,
    PingResponse,
)

router = APIRouter(tags=["chat"])


@router.post("/ping", response_model=PingResponse)
def ping(request: PingRequest) -> PingResponse:
    return PingResponse(echo=request.text, received_at=datetime.now(timezone.utc).isoformat())


@router.post("/messages", response_model=MessageRead, status_code=status.HTTP_201_CREATED)
async def create_message(
    payload: MessageCreate,
    session: AsyncSession = Depends(get_session),
) -> MessageRead:
    """Persist a message and hand analysis off to the worker.

    Gemini is not called here at all. The row is committed first and the job is
    enqueued second, so the response time is a database write plus a Redis push —
    not a 1-3s (sometimes 30s) model call. If the enqueue itself fails, the
    message is still saved and simply stays `pending`; losing an analysis is
    acceptable, losing a message is not.
    """
    message = Message(content=payload.content, sender=payload.sender)
    session.add(message)
    await session.commit()
    await session.refresh(message)

    try:
        pool = await get_pool()
        await pool.enqueue_job("analyze_message_job", str(message.id), message.content)
    except Exception as exc:  # noqa: BLE001 - a broker outage must not fail the send
        log_event(
            "analysis_enqueue_failed",
            level=40,
            message_id=str(message.id),
            error=f"{type(exc).__name__}: {exc}"[:200],
        )

    return MessageRead.model_validate(message)


@router.get("/messages/{message_id}/analysis", response_model=AnalysisRead)
async def get_message_analysis(
    message_id: UUID,
    session: AsyncSession = Depends(get_session),
) -> AnalysisRead:
    """Poll target for the analysis of one message."""
    message = await session.get(Message, message_id)
    if message is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="message not found")

    return AnalysisRead(
        message_id=message.id,
        analysis_status=message.analysis_status,
        mood=message.mood,
        toxicity_score=message.toxicity_score,
        heat_score=message.heat_score,
        rewrite_suggestion=message.rewrite_suggestion,
    )
