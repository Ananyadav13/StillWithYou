from fastapi import APIRouter, Response

from app.core.metrics import render

router = APIRouter(tags=["observability"])


@router.get("/metrics")
async def metrics() -> Response:
    """Prometheus scrape target.

    Counters are incremented by the worker and stored in Redis, so this endpoint
    reports the whole system rather than just the API process.
    """
    body, content_type = await render()
    return Response(content=body, media_type=content_type)
