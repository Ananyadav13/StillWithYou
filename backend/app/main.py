from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.core.config import settings
from app.core.logging import configure_logging, log_event
from app.core.queue import close_pool, get_pool
from app.routers import chat, health, metrics, preview
from app.routers.preview import warm_preview_model
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

    # Phase 5: the extension's preview endpoint runs the model in *this* process, and a
    # cold load costs 8.22s — long enough to blow the extension's 3s client deadline and
    # look exactly like the backend being down. Warmed on a background thread rather than
    # awaited, so the API still starts immediately for everything else.
    if settings.preview_enabled:
        warm_preview_model()
        log_event("preview_warm_started")

    log_event("startup", app=settings.app_name, environment=settings.environment)
    yield
    await close_pool()
    log_event("shutdown", app=settings.app_name)


app = FastAPI(title=settings.app_name, lifespan=lifespan)

# The extension's own network calls come from its background service worker, which
# holds `host_permissions` for this API and is therefore not subject to CORS at all —
# that is why the fetch lives there rather than in the content script (a content-script
# fetch would carry https://web.whatsapp.com as its origin, and making *that* work would
# mean configuring this backend to accept cross-origin requests from a third-party site).
# The regex below is belt-and-braces for anything that does send an extension origin,
# such as a page opened from chrome-extension:// during debugging. Extension ids are 32
# characters in a-p; the pattern will not match a normal web origin.
#
# Note it is a *regex* rather than an entry in CORS_ORIGINS because an unpacked
# extension's id is machine-specific, so it cannot be written into shared config.
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_origin_regex=r"^chrome-extension://[a-p]{32}$",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(health.router)
app.include_router(chat.router)
app.include_router(metrics.router)
app.include_router(preview.router)
