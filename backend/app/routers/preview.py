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
The model lives in the worker process too, but this endpoint needs its own copy in the
API process. `load_preview_model()` is awaited from `lifespan`, so the load completes
**before uvicorn opens the listening socket** — the first request after a restart pays
nothing. See that function's docstring for the measurements that forced this, including
the version of it that loaded on a background thread and left the first caller to absorb
a 3s timeout while `/health` reported `ok`.

The honest price of this endpoint is ~1.1GB resident in the API process plus that load
time added to every boot, and it is opt-out via `PREVIEW_ENABLED=false`.
"""

import asyncio
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


async def load_preview_model() -> str:
    """Load the model during startup, before the server accepts any traffic.

    This is awaited from `lifespan`, so uvicorn does not open the listening socket until
    it returns. That is the whole fix, and it is worth being precise about what it buys.

    THE BUG IT REPLACES
    -------------------
    This used to run on a daemon thread so startup would not block. The model then loaded
    *concurrently with serving*, which produced the worst of both worlds — measured on a
    fresh process with an immediate request:

        boot -> port accepts TCP          5286 ms
        GET  /health                       696 ms   {"status": "ok"}   <- claimed ready
        POST /analyze-preview  #1         3030 ms   <- TIMED OUT at the client deadline
        POST /analyze-preview  #2        31752 ms   <- waited out the load
        preview_model_ready              34004 ms

    Two separate defects. The endpoint blocked past the caller's 3s deadline, and
    `/health` answered `ok` the entire time — so nothing observable distinguished "still
    warming up" from "broken", and the first real user absorbed the difference.

    Loading here inverts that. During the load the port is simply not open, so a caller
    gets an immediate connection refusal rather than a hang. For the extension that is
    the `unreachable` branch, which is already specified to fail silently: no banner, one
    logged line, nothing shown to a WhatsApp user. A closed port is a far more honest
    signal than a `/health` that says ok while the thing it depends on is missing.

    THE COST
    --------
    Boot-to-ready grows by the full load. That is a real trade and it is taken
    deliberately: a slow, visible, once-per-restart cost paid by the operator beats a
    hidden one paid by whichever request happened to arrive first.

    Failure is logged and swallowed rather than aborting startup. `analyze_multilingual`
    degrades to the Phase 2 lexicon on its own if the model never arrives, and the rest
    of the API — `POST /messages`, the poll endpoint, `/metrics` — has nothing to do with
    this model and must not be taken down by it.

    @returns one of "ready" | "unavailable" | "disabled", for /health to report.
    """
    if not settings.preview_enabled:
        log_event("preview_model_skipped", reason="preview_disabled")
        return "disabled"

    started = time.perf_counter()
    try:
        # In a thread, not inline: this is 25-34s of blocking CPU and I/O, and running it
        # directly on the event loop would make the process ignore Ctrl+C for the whole
        # load. The loop stays responsive; the startup sequence still waits.
        await asyncio.to_thread(warm_multilingual)
        elapsed = round((time.perf_counter() - started) * 1000, 1)
        log_event("preview_model_ready", elapsed_ms=elapsed, blocking_startup=True)
        return "ready"
    except Exception as exc:  # noqa: BLE001 - a cold model must not break the whole API
        log_event(
            "preview_model_load_failed",
            level=40,
            elapsed_ms=round((time.perf_counter() - started) * 1000, 1),
            error=f"{type(exc).__name__}: {exc}"[:200],
        )
        return "unavailable"


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
