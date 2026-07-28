"""Read-only analysis for the browser extension.

`POST /analyze-preview` scores a message that has not been sent and may never be sent.
It runs the same `detect_language` -> cache -> `analyze_multilingual` path as the worker
and returns the same `AnalysisResult` fields, but it **writes no message row and enqueues
no job**.

Why not reuse POST /messages
----------------------------
Because it persists. The extension analyses on a typing pause, so a single WhatsApp
message would leave several partial drafts of itself permanently in the `messages` table
and several jobs in the queue. That is wrong on privacy grounds before it is wrong on
load grounds: this endpoint exists to serve a conversation happening inside somebody
else's application, and storing fragments of it is not something the user asked for.

Why this may run analysis synchronously, when POST /messages may not
--------------------------------------------------------------------
This is the one place in the project where the central architectural rule — analysis
never sits in the request path — is broken on purpose, so the justification lives here
rather than in a document.

  * The rule was written because Gemini's tail latency could not be bounded: a measured
    1410ms median, with 3.2s and 30s observed. **Gemini is never called from this
    endpoint at all**, regardless of `GEMINI_ENABLED`. The active analyzer is
    `multilingual_local` at a measured 40ms median / 49.4ms p95 — three orders of
    magnitude away from the problem the rule was written for. If the Gemini flag is ever
    flipped back on, this endpoint must not start putting a 1.4s dependency in a
    synchronous path, which is why the call below is to `analyze_multilingual` directly
    rather than to a shared "analyse anything" helper that could later grow a Gemini
    branch.
  * Nothing is persisted, so the asynchronous design's actual guarantee — a user's
    message survives even when analysis fails — has nothing to protect here. There is no
    message. A failed preview costs a banner, and a banner is not somebody's words.
  * The caller holds a 3s deadline of its own (`extension/api.js`), so a slow response is
    bounded at the client whatever the server does.

The 40ms is CPU-bound torch work, so it runs in a worker thread rather than on the event
loop. 40ms of blocking inference on the loop would stall every concurrent request,
including the `POST /messages` path whose latency this project actually promises
something about.

Cold start
----------
The model lives in the worker process today; the first call in a cold API process pays
the full 8.22s load, which would blow the client's 3s deadline and be indistinguishable
from the backend being down. `warm_preview_model()` is therefore kicked off during
startup, on a background thread so it does not delay the API becoming ready. The honest
price of this endpoint is ~1.1GB resident in the API process, and it is opt-out via
`PREVIEW_ENABLED=false`.
"""

import asyncio
import threading
import time

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field

from app.core.config import settings
from app.core.logging import log_event
from app.core.metrics import incr
from app.schemas.analysis import AnalysisSource
from app.services.cache import get_cached, set_cached
from app.services.language_detect import detect_language
from app.services.multilingual_local import analyze_multilingual, warm as warm_multilingual

router = APIRouter(tags=["preview"])


class PreviewRequest(BaseModel):
    # Same ceiling as MessageCreate. A compose box can hold more than anyone will type,
    # and an unbounded body is an unbounded tokenizer call.
    content: str = Field(min_length=1, max_length=4000)


class PreviewResponse(BaseModel):
    """Deliberately mirrors AnalysisRead's field names minus the row-shaped ones.

    No `message_id` and no `analysis_status`: there is no row, and the answer is always
    complete by the time it is returned. Two fields are added that the polled endpoint
    has no way to report — `language`, because the extension logs it for the same
    per-mode visibility /metrics gives the worker, and `cached`, so a test can tell a
    real inference from a cache hit without timing it.
    """

    mood: str
    toxicity_score: float
    heat_score: float
    rewrite_suggestion: str | None = None
    source: AnalysisSource
    language: str
    cached: bool


def warm_preview_model() -> None:
    """Load the model off the request path, on a background thread.

    Startup must not block on this: an 8.22s load in `lifespan` would delay the API
    accepting *any* traffic, including the endpoints that have nothing to do with
    previews. Failure here is logged and otherwise ignored — `analyze_multilingual`
    degrades to the lexicon on its own if the model never arrives.
    """

    def _run() -> None:
        started = time.perf_counter()
        try:
            warm_multilingual()
            log_event("preview_model_ready", elapsed_ms=round((time.perf_counter() - started) * 1000, 1))
        except Exception as exc:  # noqa: BLE001 - a cold model must not break startup
            log_event(
                "preview_model_warm_failed",
                level=40,
                error=f"{type(exc).__name__}: {exc}"[:200],
            )

    threading.Thread(target=_run, name="preview-warm", daemon=True).start()


@router.post("/analyze-preview", response_model=PreviewResponse)
async def analyze_preview(payload: PreviewRequest) -> PreviewResponse:
    """Score an unsent message. Persists nothing."""
    if not settings.preview_enabled:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="preview analysis is disabled"
        )

    content = payload.content
    language = detect_language(content)
    started = time.perf_counter()

    # Shared with the worker: the key is a SHA-256 of the normalised text, so a preview
    # of a message the user goes on to actually send is already warm when the worker
    # looks. The extension's repeated analyses of the same paused draft are free after
    # the first.
    cached = await get_cached(content)
    if cached is not None:
        await incr("preview_request", outcome="cache_hit", language=language)
        log_event(
            "preview_analysis",
            language=language,
            source=cached.source,
            mood=cached.mood,
            cache="hit",
            elapsed_ms=round((time.perf_counter() - started) * 1000, 2),
        )
        return PreviewResponse(**cached.model_dump(), language=language, cached=True)

    # Off the event loop: see the module docstring. `analyze_multilingual` does not
    # raise by contract — it degrades to the Phase 2 lexicon internally — so there is
    # nothing to catch here that would not be a bug worth surfacing as a 500.
    result = await asyncio.to_thread(analyze_multilingual, content)

    await set_cached(content, result)
    await incr("preview_request", outcome="analyzed", language=language)
    await incr("analysis_local", language=language, mood=result.mood)

    log_event(
        "preview_analysis",
        language=language,
        source=result.source,
        mood=result.mood,
        heat_score=result.heat_score,
        cache="miss",
        elapsed_ms=round((time.perf_counter() - started) * 1000, 2),
    )

    return PreviewResponse(**result.model_dump(), language=language, cached=False)
