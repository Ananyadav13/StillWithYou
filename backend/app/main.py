from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.core.config import settings
from app.core.logging import configure_logging, log_event
from app.core.queue import close_pool, get_pool
from app.routers import chat, health, metrics, preview
from app.routers.preview import load_preview_model
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

    # Phase 5: the extension's preview endpoint runs the multilingual model in *this*
    # process. This load is AWAITED on purpose — it is the last thing before `yield`, and
    # uvicorn does not open the listening socket until lifespan startup returns, so the
    # model is resident before any request can arrive.
    #
    # It was previously started on a background thread so boot would stay fast. That was
    # wrong, and measurably so: the model finished loading 34.0s in, while the socket
    # opened at 5.3s, so a request arriving in between blocked past the caller's 3s
    # deadline and timed out — and `/health` answered `ok` throughout. The cost of fixing
    # it is that boot now takes as long as the load; the benefit is that the cost is
    # paid once, by the operator, visibly, instead of by whichever user happened to be
    # first. `docs/phase5-scope.md` has the before/after numbers.
    #
    # A failed load does not abort startup: the rest of the API has nothing to do with
    # this model, and `analyze_multilingual` degrades to the Phase 2 lexicon on its own.
    app.state.preview_model = await load_preview_model()

    log_event(
        "startup",
        app=settings.app_name,
        environment=settings.environment,
        preview_model=app.state.preview_model,
    )
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
