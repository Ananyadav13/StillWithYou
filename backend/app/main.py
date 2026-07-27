from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.core.config import settings
from app.core.logging import configure_logging, log_event
from app.core.queue import close_pool, get_pool
from app.routers import chat, health, metrics
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

    # Same reasoning as the Gemini client: build the Redis pool now, not inside the
    # first POST. Creating it lazily put ~300ms of connection setup onto whichever
    # request happened to be first, which is exactly the request-path latency this
    # step exists to remove.
    try:
        await get_pool()
        log_event("queue_pool_ready", redis=settings.redis_url)
    except Exception as exc:  # noqa: BLE001 - the API must serve even if Redis is down
        log_event("queue_pool_unavailable", level=40, error=f"{type(exc).__name__}: {exc}")

    log_event("startup", app=settings.app_name, environment=settings.environment)
    yield
    await close_pool()
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
app.include_router(metrics.router)
