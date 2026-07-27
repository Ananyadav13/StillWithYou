"""Async SQLAlchemy engine, session factory, and FastAPI session dependency."""

from collections.abc import AsyncIterator

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase

from app.core.config import settings


class Base(DeclarativeBase):
    """Declarative base for every ORM model."""


engine = create_async_engine(settings.database_url, echo=False, pool_pre_ping=True)

SessionLocal = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


async def get_session() -> AsyncIterator[AsyncSession]:
    """FastAPI dependency yielding a session that is closed after the request."""
    async with SessionLocal() as session:
        yield session
