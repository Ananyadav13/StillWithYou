"""The messages table.

Every Gemini-derived column here is nullable, and `analysis_status` starts at
`pending`. A message row is complete and valid the moment the user sends it —
analysis is additive and arrives later, or never. See app/routers/chat.py for the
commit-then-enqueue ordering that makes that guarantee hold.
"""

import enum
import uuid
from datetime import datetime

from sqlalchemy import DateTime, Enum, Float, String, Text, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base


class AnalysisStatus(str, enum.Enum):
    pending = "pending"
    complete = "complete"
    failed = "failed"


class Message(Base):
    __tablename__ = "messages"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    sender: Mapped[str] = mapped_column(String(16), nullable=False, default="user")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    analysis_status: Mapped[AnalysisStatus] = mapped_column(
        Enum(AnalysisStatus, name="analysis_status"),
        nullable=False,
        default=AnalysisStatus.pending,
        server_default=AnalysisStatus.pending.value,
        index=True,
    )
    # Which engine produced the scores below: "gemini", "local_fallback" or
    # "multilingual_local". Kept so a degraded result is never mistaken for a
    # full-fidelity one downstream.
    #
    # 32, not 16: "multilingual_local" is 18 characters and silently blew past the
    # original limit with a StringDataRightTruncationError on every write. Sized to
    # leave room for the next analyzer name rather than to fit the current longest.
    analysis_source: Mapped[str | None] = mapped_column(String(32), nullable=True)
    mood: Mapped[str | None] = mapped_column(String(32), nullable=True)
    toxicity_score: Mapped[float | None] = mapped_column(Float, nullable=True)
    heat_score: Mapped[float | None] = mapped_column(Float, nullable=True)
    rewrite_suggestion: Mapped[str | None] = mapped_column(Text, nullable=True)
