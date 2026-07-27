import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

from app.models.message import AnalysisStatus


class PingRequest(BaseModel):
    text: str


class PingResponse(BaseModel):
    echo: str
    received_at: str


class MessageCreate(BaseModel):
    content: str = Field(min_length=1, max_length=4000)
    sender: str = "user"


class MessageRead(BaseModel):
    """What POST /messages returns: the durable row, with no analysis in it.

    `analysis_status` is `pending` on creation. Clients poll
    GET /messages/{id}/analysis for the result.
    """

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    content: str
    sender: str
    created_at: datetime
    analysis_status: AnalysisStatus


class AnalysisRead(BaseModel):
    """What GET /messages/{id}/analysis returns.

    Scores are null while status is `pending`, and stay null if it ends `failed`.
    """

    model_config = ConfigDict(from_attributes=True)

    message_id: uuid.UUID
    analysis_status: AnalysisStatus
    analysis_source: str | None = None
    mood: str | None = None
    toxicity_score: float | None = None
    heat_score: float | None = None
    rewrite_suggestion: str | None = None
