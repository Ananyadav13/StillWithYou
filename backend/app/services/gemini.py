"""Gemini-backed message analysis.

`analyze_message` is the single place the Gemini API is called. It raises on every
failure path rather than swallowing errors, so callers can decide what a failure
means — Phase 2 layers a circuit breaker and a local fallback on top of it, and
both need to see the exception.

Every raised GeminiError carries a `kind` drawn from FailureKind, which maps 1:1
onto the four failure modes enumerated in docs/phase2-slo.md and onto the
`outcome` label on the gemini_call_total metric.
"""

import asyncio
import json
from typing import Literal

from google import genai
from google.genai import errors as genai_errors
from google.genai import types

from app.core.config import settings
from app.schemas.analysis import AnalysisResult

FailureKind = Literal["rate_limit", "server_error", "timeout", "malformed", "error"]

SYSTEM_INSTRUCTION = """You analyse a single chat message sent between two people \
in a close relationship. Judge only the message given to you.

Return JSON with exactly these keys:
  mood: one lowercase word for the sender's emotional state (calm, hurt, angry, \
warm, anxious, distant, playful, ...)
  toxicity_score: float 0.0-1.0, where 0.0 is kind and 1.0 is abusive
  heat_score: float 0.0-1.0, where 0.0 is cool and 1.0 is an escalated fight
  rewrite_suggestion: a softer rephrasing that keeps the sender's intent, or null \
if the message is already kind

Be strict about toxicity: insults, contempt and blame score above 0.6."""

_RESPONSE_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "mood": {"type": "STRING"},
        "toxicity_score": {"type": "NUMBER"},
        "heat_score": {"type": "NUMBER"},
        "rewrite_suggestion": {"type": "STRING", "nullable": True},
    },
    "required": ["mood", "toxicity_score", "heat_score"],
}

_client: genai.Client | None = None


class GeminiError(RuntimeError):
    """Any failure to obtain a usable analysis from Gemini."""

    def __init__(self, message: str, kind: FailureKind = "error") -> None:
        super().__init__(message)
        self.kind = kind


def get_client() -> genai.Client:
    """Lazily build the Gemini client so importing this module never needs a key."""
    global _client
    if _client is None:
        if not settings.gemini_api_key:
            raise GeminiError("GEMINI_API_KEY is not configured", kind="error")
        _client = genai.Client(api_key=settings.gemini_api_key)
    return _client


def reset_client() -> None:
    """Drop the cached client so a changed API key takes effect (used by tests)."""
    global _client
    _client = None


def _classify(exc: Exception) -> FailureKind:
    """Map an SDK exception onto one of the failure modes we plan for."""
    code = getattr(exc, "code", None)
    if code == 429:
        return "rate_limit"
    if isinstance(code, int) and 500 <= code < 600:
        return "server_error"
    if isinstance(exc, genai_errors.ServerError):
        return "server_error"
    return "error"


async def _call_gemini(content: str) -> str:
    client = get_client()
    response = await client.aio.models.generate_content(
        model=settings.gemini_model,
        contents=content,
        config=types.GenerateContentConfig(
            system_instruction=SYSTEM_INSTRUCTION,
            response_mime_type="application/json",
            response_schema=_RESPONSE_SCHEMA,
            temperature=0.2,
            # Measured, not guessed: with the model's default thinking level this
            # prompt ran 6-12.6s and blew the 2s SLO on every call. thinking_level
            # "low" brought the same five prompts to a 1410ms median, 5/5 under 2s.
            # Mood/toxicity scoring of one short message needs no deep reasoning.
            thinking_config=types.ThinkingConfig(thinking_level="low"),
        ),
    )
    return (response.text or "").strip()


async def analyze_message(content: str) -> AnalysisResult:
    """Analyse one message. Raises GeminiError on timeout, API error or bad JSON.

    The deadline is enforced here rather than through http_options.timeout: the
    API rejects server-side deadlines under 10s ("Manually set deadline 3s is too
    short"), and 3s is our budget, not theirs. asyncio.wait_for cancels the request
    at our ceiling regardless of what the remote side is willing to promise.
    """
    try:
        raw = await asyncio.wait_for(
            _call_gemini(content), timeout=settings.gemini_timeout_seconds
        )
    except asyncio.TimeoutError as exc:
        raise GeminiError(
            f"gemini exceeded the {settings.gemini_timeout_seconds}s deadline", kind="timeout"
        ) from exc
    except GeminiError:
        raise
    except Exception as exc:  # noqa: BLE001 - the SDK raises a wide range of types
        raise GeminiError(
            f"gemini call failed: {type(exc).__name__}: {exc}", kind=_classify(exc)
        ) from exc

    if not raw:
        raise GeminiError("gemini returned an empty response", kind="malformed")

    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise GeminiError(
            f"gemini returned unparseable JSON: {raw[:200]!r}", kind="malformed"
        ) from exc

    try:
        return AnalysisResult(**payload, source="gemini")
    except (TypeError, ValueError) as exc:
        raise GeminiError(
            f"gemini returned an unusable analysis: {payload!r}", kind="malformed"
        ) from exc
