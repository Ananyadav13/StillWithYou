from datetime import datetime, timezone

from fastapi import APIRouter, Depends, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_session
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
    try:
        analysis = await analyze_message(message.content)
    except GeminiError:
        # Swallowed on purpose: see the docstring. Phase 2 Step 1 adds structured
        # logging here so these failures stop being invisible.
        analysis = None

    return MessageRead.model_validate(message).model_copy(update={"analysis": analysis})
