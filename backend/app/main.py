from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.core.config import settings
from app.core.logging import configure_logging, log_event
from app.routers import chat, health
from app.services.gemini import GeminiError, get_client

configure_logging()


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Build the Gemini client up front. Constructing it lazily inside the first
    # request runs synchronous setup on the event loop, which once blocked a cold
    # process for 592s and prevented asyncio.wait_for from firing at all.
    try:
        get_client()
        log_event("gemini_client_ready", model=settings.gemini_model)
    except GeminiError as exc:
        log_event("gemini_client_unavailable", level=30, error=str(exc))

    log_event("startup", app=settings.app_name, environment=settings.environment)
    yield
    log_event("shutdown", app=settings.app_name)


app = FastAPI(title=settings.app_name, lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(health.router)
app.include_router(chat.router)
