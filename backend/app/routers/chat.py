from datetime import datetime, timezone

from fastapi import APIRouter

from app.schemas.message import PingRequest, PingResponse

router = APIRouter(tags=["chat"])


@router.post("/ping", response_model=PingResponse)
def ping(request: PingRequest) -> PingResponse:
    return PingResponse(echo=request.text, received_at=datetime.now(timezone.utc).isoformat())
