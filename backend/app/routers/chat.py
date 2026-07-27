from datetime import datetime, timezone

from fastapi import APIRouter, Depends, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_session
from app.core.logging import track_analysis
from app.models.message import Message
from app.schemas.message import MessageCreate, MessageRead, PingRequest, PingResponse
from app.services.gemini import GeminiError, analyze_message

router = APIRouter(tags=["chat"])


@router.post("/ping", response_model=PingResponse)
def ping(request: PingRequest) -> PingResponse:
    return PingResponse(echo=request.text, received_at=datetime.now(timezone.utc).isoformat())


@router.post("/messages", response_model=MessageRead, status_code=status.HTTP_201_CREATED)
async def create_message(
    payload: MessageCreate,
    session: AsyncSession = Depends(get_session),
) -> MessageRead:
    """Persist a message, then try to analyse it.

    The commit happens *before* Gemini is touched, and the analysis call is wrapped
    so no Gemini failure can propagate. A user's message is never lost because a
    third-party API was slow, rate-limited or down; the worst outcome is a 201 with
    `analysis: null`.
    """
    message = Message(content=payload.content, sender=payload.sender)
    session.add(message)
    await session.commit()
    await session.refresh(message)

    analysis = None
    with track_analysis(message.id) as tracked:
        try:
            analysis = await analyze_message(message.content)
            tracked.success(source=analysis.source, mood=analysis.mood)
        except GeminiError as exc:
            # Swallowed on purpose: see the docstring. Structured logging means a
            # swallowed failure is still a recorded one.
            tracked.error(failure_kind=exc.kind, error=str(exc)[:200])
            analysis = None

    return MessageRead.model_validate(message).model_copy(update={"analysis": analysis})
