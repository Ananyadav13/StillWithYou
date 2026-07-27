"""The messages table.

Phase 1 note: this model deliberately carries no Gemini-derived columns. A message
is a complete, valid row the moment the user sends it — analysis is additive and
arrives later (or never, if Gemini is down). See app/routers/chat.py for the
commit-then-analyse ordering that makes that guarantee hold.
"""

import uuid
from datetime import datetime

from sqlalchemy import DateTime, String, Text, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base


class Message(Base):
    __tablename__ = "messages"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    sender: Mapped[str] = mapped_column(String(16), nullable=False, default="user")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
