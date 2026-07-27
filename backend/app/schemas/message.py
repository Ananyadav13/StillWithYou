import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

from app.schemas.analysis import AnalysisResult


class PingRequest(BaseModel):
    text: str


class PingResponse(BaseModel):
    echo: str
    received_at: str


class MessageCreate(BaseModel):
    content: str = Field(min_length=1, max_length=4000)
    sender: str = "user"


class MessageRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    content: str
    sender: str
    created_at: datetime

    # Null whenever Gemini was unavailable. The message itself is still persisted
    # and returned — analysis is additive, never a precondition.
    analysis: AnalysisResult | None = None
