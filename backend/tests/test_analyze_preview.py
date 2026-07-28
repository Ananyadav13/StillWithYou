"""POST /analyze-preview: the browser extension's read-only analysis endpoint.

Requires Redis and Postgres to be up (`docker compose up -d`), same as the other
suites, and for the same reason: the properties under test here are about what does
*not* reach the datastore, which a mocked datastore cannot demonstrate.

The load-bearing test in this file is `test_preview_writes_no_message_row`. Everything
else is behaviour; that one is the boundary. The extension analyses on a typing pause,
so if this endpoint ever starts persisting, a user typing one WhatsApp message leaves
several partial drafts of it in the database — a privacy failure, not a load one.
"""

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import func, select

from app.core.config import settings
from app.core.db import SessionLocal
from app.core.metrics import reset as reset_metrics
from app.main import app
from app.models.message import Message
from app.routers.preview import load_preview_model
from app.services import cache as cache_module

pytestmark = pytest.mark.asyncio(loop_scope="session")

# Long enough to be unambiguous to the analyzer, and containing no term from the
# escalation lexicon — the same rule Phase 3's heated fixtures follow, so this asserts
# on the model's opinion rather than on a keyword lookup.
HEATED = "Forget it. I'm done asking you for anything."
CALM = "Thank you for covering for me yesterday, it genuinely helped."


@pytest_asyncio.fixture(autouse=True, loop_scope="session")
async def clean_state():
    await cache_module.clear()
    await reset_metrics()
    yield
    await cache_module.clear()


@pytest_asyncio.fixture(loop_scope="session")
async def client():
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as async_client:
        yield async_client


async def _message_count() -> int:
    async with SessionLocal() as session:
        return (await session.execute(select(func.count()).select_from(Message))).scalar_one()


async def test_preview_returns_analysis(client):
    response = await client.post("/analyze-preview", json={"content": HEATED})

    assert response.status_code == 200
    body = response.json()

    assert body["mood"] in {"calm", "neutral", "frustrated", "angry"}
    assert 0.0 <= body["toxicity_score"] <= 1.0
    assert 0.0 <= body["heat_score"] <= 1.0
    assert body["source"] == "multilingual_local"
    assert body["language"] == "en"
    assert body["cached"] is False


async def test_preview_writes_no_message_row(client):
    """The boundary. A preview must leave no trace in the messages table."""
    before = await _message_count()

    for text in (HEATED, CALM, "kal se main kuch nahi bolungi is baare mein"):
        assert (await client.post("/analyze-preview", json={"content": text})).status_code == 200

    assert await _message_count() == before


async def test_preview_never_calls_gemini_even_when_enabled(monkeypatch, client):
    """`GEMINI_ENABLED=true` must not put a 1.4s dependency in this synchronous path.

    Phase 2 measured Gemini at a 1410ms median with 3.2s and 30s observed. The whole
    argument for allowing analysis in *this* request path is that the analyzer is
    `multilingual_local` at ~40ms. If flipping the Gemini flag silently changed which
    engine answered here, that argument would quietly stop being true — and the failure
    would show up as the extension's 3s deadline firing, not as anything obviously
    caused by a config change.
    """
    monkeypatch.setattr(settings, "gemini_enabled", True)

    def _explode(*args, **kwargs):
        raise AssertionError("preview must never reach Gemini")

    monkeypatch.setattr("app.services.gemini.analyze_message", _explode)

    response = await client.post("/analyze-preview", json={"content": HEATED})

    assert response.status_code == 200
    assert response.json()["source"] == "multilingual_local"


async def test_preview_second_call_is_a_cache_hit(client):
    """Repeated analysis of the same paused draft must be free after the first.

    This is what makes the debounced extension affordable: a user who pauses several
    times without changing the text costs one inference, not several.
    """
    first = await client.post("/analyze-preview", json={"content": CALM})
    second = await client.post("/analyze-preview", json={"content": CALM})

    assert first.json()["cached"] is False
    assert second.json()["cached"] is True
    # Same answer either way — a cache hit is not a degraded answer.
    assert first.json()["mood"] == second.json()["mood"]
    assert first.json()["heat_score"] == second.json()["heat_score"]


async def test_preview_shares_the_cache_with_the_worker(client):
    """A preview of a message that then gets sent should already be warm.

    The cache key is a SHA-256 of the normalised text and carries no message id, so the
    worker's lookup for a real send hits the entry this endpoint wrote. Asserted rather
    than assumed because it is the only reason previews are not pure extra load.
    """
    await client.post("/analyze-preview", json={"content": HEATED})

    cached = await cache_module.get_cached(HEATED)

    assert cached is not None
    assert cached.source == "multilingual_local"


async def test_preview_normalisation_matches_the_cache(client):
    """Case and whitespace differences must not cost a second inference — the compose
    box produces plenty of both while someone is still editing."""
    await client.post("/analyze-preview", json={"content": CALM})
    variant = await client.post("/analyze-preview", json={"content": f"  {CALM.upper()}  "})

    assert variant.json()["cached"] is True


async def test_preview_rejects_empty_and_oversized_content(client):
    assert (await client.post("/analyze-preview", json={"content": ""})).status_code == 422
    assert (
        await client.post("/analyze-preview", json={"content": "x" * 4001})
    ).status_code == 422


async def test_model_loads_eagerly_and_reports_ready():
    """The cold-start fix: startup loads the model and says so.

    Before this, loading ran on a background thread while the server accepted traffic,
    and the first request timed out at the client's 3s deadline while /health still
    answered `ok`. Measurements in `load_preview_model`'s docstring.

    This asserts the contract rather than the timing — the timing lives in
    `scripts/measure_cold_start.py`, because a wall-clock assertion on a 30s model load
    would be a flaky test on a shared laptop.
    """
    state = await load_preview_model()

    assert state == "ready"
    # The load is idempotent and cheap once warm — `lifespan` running twice (reload,
    # test re-entry) must not cost a second 30s load or a second 1.1GB.
    assert await load_preview_model() == "ready"


async def test_model_load_reports_disabled_when_preview_is_off(monkeypatch):
    """`PREVIEW_ENABLED=false` must skip the load entirely, not just hide the endpoint.

    The 1.1GB and the ~30s boot are the whole reason the off-switch exists; loading
    anyway and only 404ing the route would pay the cost and deliver none of the benefit.
    """
    monkeypatch.setattr(settings, "preview_enabled", False)

    assert await load_preview_model() == "disabled"


async def test_health_reports_the_model_state(client):
    """/health distinguishes ready from unavailable.

    A flat `{"status": "ok"}` was actively misleading during the cold-start bug: it was
    the only observable signal and it said "fine" throughout. `unavailable` is the case
    that matters, because `analyze_multilingual` silently degrades to the Phase 2 lexicon
    rather than failing — so a broken model is invisible without this field.
    """
    client._transport.app.state.preview_model = "ready"
    body = (await client.get("/health")).json()
    assert body == {"status": "ok", "preview_model": "ready"}

    client._transport.app.state.preview_model = "unavailable"
    assert (await client.get("/health")).json()["preview_model"] == "unavailable"


async def test_health_survives_state_never_being_set(client):
    """Lifespan not having run must not 500 the health check — ASGITransport in these
    very tests is one such caller, and so is any future in-process embedding."""
    if hasattr(client._transport.app.state, "preview_model"):
        delattr(client._transport.app.state, "preview_model")

    response = await client.get("/health")

    assert response.status_code == 200
    assert response.json()["preview_model"] == "unknown"


async def test_preview_404s_when_disabled(monkeypatch, client):
    """`PREVIEW_ENABLED=false` is the off-switch for a deployment that does not serve
    the extension and should not pay 1.1GB of resident model for it."""
    monkeypatch.setattr(settings, "preview_enabled", False)

    response = await client.post("/analyze-preview", json={"content": HEATED})

    assert response.status_code == 404
