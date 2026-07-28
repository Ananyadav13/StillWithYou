from fastapi import APIRouter, Request

router = APIRouter(prefix="/health", tags=["health"])


@router.get("")
def health_check(request: Request) -> dict[str, str]:
    """Liveness, plus the one piece of state that is not obvious from the outside.

    `status` is always `ok` here: if this handler runs at all, the process is serving.

    `preview_model` exists because a flat `ok` was actively misleading during Phase 5's
    cold-start bug. The model used to load on a background thread while the server
    accepted traffic, and `/health` answered `{"status": "ok"}` for the full 34s it took
    — so the one observable signal said "fine" while `/analyze-preview` was timing out.

    Loading now blocks startup, so by the time this endpoint can be reached the value is
    settled and can only be:

        ready        the model is resident; /analyze-preview answers in ~50ms
        unavailable  the load failed; /analyze-preview still answers, degraded to the
                     Phase 2 lexicon via analyze_multilingual's own fallback
        disabled     PREVIEW_ENABLED=false; /analyze-preview returns 404

    `unavailable` is the one worth alerting on, and it is reported rather than inferred
    precisely because the endpoint keeps working when it happens — a degraded analyzer
    that still answers is invisible without this.
    """
    return {
        "status": "ok",
        "preview_model": getattr(request.app.state, "preview_model", "unknown"),
    }
