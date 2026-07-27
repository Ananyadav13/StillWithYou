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
import hashlib
import json
import time
from typing import Literal

from google import genai
from google.genai import errors as genai_errors
from google.genai import types

from app.core.config import settings
from app.core.logging import log_event
from app.schemas.analysis import AnalysisResult

FailureKind = Literal[
    "rate_limit", "server_error", "timeout", "malformed", "rejected", "error"
]

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

# One client per configured key, plus the time each key is allowed to be used again.
_clients: dict[int, genai.Client] = {}
_cooldown_until: dict[int, float] = {}
_rotation_cursor = 0

# A key that returned 429 is out of quota; give it a minute before trying again.
RATE_LIMIT_COOLDOWN_SECONDS = 60.0
# A key the API rejected outright is misconfigured; sideline it for longer.
REJECTED_KEY_COOLDOWN_SECONDS = 300.0


class GeminiError(RuntimeError):
    """Any failure to obtain a usable analysis from Gemini."""

    def __init__(self, message: str, kind: FailureKind = "error") -> None:
        super().__init__(message)
        self.kind = kind


def key_fingerprint(key: str) -> str:
    """Stable short id for logs. Never log the key itself."""
    return hashlib.sha256(key.encode()).hexdigest()[:8]


def _client_for(index: int) -> genai.Client:
    if index not in _clients:
        _clients[index] = genai.Client(api_key=settings.gemini_api_keys[index])
    return _clients[index]


def get_client() -> genai.Client:
    """The client for the first configured key. Used to warm connections at startup."""
    if not settings.gemini_api_keys:
        raise GeminiError("no Gemini API key is configured", kind="error")
    return _client_for(0)


def _key_order() -> list[int]:
    """Indices to try, healthy keys first, starting from a rotating offset.

    The rotating start spreads load across the pool instead of hammering key 0
    until it hits its quota. Cooling keys are still returned, last — a stale
    cooldown is a worse outcome than one wasted 429.
    """
    global _rotation_cursor
    count = len(settings.gemini_api_keys)
    if count == 0:
        return []

    start = _rotation_cursor % count
    _rotation_cursor += 1
    order = [(start + offset) % count for offset in range(count)]

    now = time.monotonic()
    healthy = [i for i in order if _cooldown_until.get(i, 0.0) <= now]
    cooling = [i for i in order if _cooldown_until.get(i, 0.0) > now]
    return healthy + cooling


def _sideline(index: int, seconds: float, reason: str) -> None:
    _cooldown_until[index] = time.monotonic() + seconds
    log_event(
        "gemini_key_sidelined",
        level=30,
        key_index=index,
        key=key_fingerprint(settings.gemini_api_keys[index]),
        cooldown_seconds=seconds,
        reason=reason,
    )


def reset_client() -> None:
    """Drop cached clients and cooldowns so changed keys take effect (used by tests)."""
    _clients.clear()
    _cooldown_until.clear()


def _classify(exc: Exception) -> FailureKind:
    """Map an SDK exception onto one of the failure modes we plan for."""
    code = getattr(exc, "code", None)
    if code == 429:
        return "rate_limit"
    if code in (401, 403):
        # This key is bad or revoked; a different key may well work.
        return "rejected"
    if isinstance(code, int) and 500 <= code < 600:
        return "server_error"
    if isinstance(exc, genai_errors.ServerError):
        return "server_error"
    return "error"


async def _call_gemini(content: str) -> str:
    """Try each configured key until one answers.

    Rotation only helps the failure modes that are *per-key* — quota exhaustion and
    a rejected key. A 5xx or a hang is server-side and identical on every key, so
    those raise immediately rather than burning the rest of the pool (and the
    remaining deadline) rediscovering the same outage three times.
    """
    keys = settings.gemini_api_keys
    if not keys:
        raise GeminiError("no Gemini API key is configured", kind="error")

    order = _key_order()
    last_error: GeminiError | None = None

    for position, index in enumerate(order):
        try:
            return await _call_with_key(index, content)
        except GeminiError as exc:
            last_error = exc

            if exc.kind == "rate_limit":
                _sideline(index, RATE_LIMIT_COOLDOWN_SECONDS, "rate_limit")
            elif exc.kind == "rejected":
                _sideline(index, REJECTED_KEY_COOLDOWN_SECONDS, "key_rejected")
            else:
                # Not a key-specific problem — another key would fail the same way.
                raise

            if position + 1 < len(order):
                log_event(
                    "gemini_key_rotated",
                    level=30,
                    from_key=key_fingerprint(keys[index]),
                    to_key=key_fingerprint(keys[order[position + 1]]),
                    reason=exc.kind,
                )

    raise last_error or GeminiError("every configured Gemini key failed", kind="rate_limit")


async def _call_with_key(index: int, content: str) -> str:
    """One attempt with one key. Wraps SDK exceptions so the caller can route on kind."""
    client = _client_for(index)
    try:
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
    except asyncio.CancelledError:
        # The deadline in analyze_message fired. Not this key's fault — let it through
        # untouched so it is not misread as a per-key failure worth rotating on.
        raise
    except Exception as exc:  # noqa: BLE001 - the SDK raises a wide range of types
        raise GeminiError(
            f"gemini call failed on key {key_fingerprint(settings.gemini_api_keys[index])}: "
            f"{type(exc).__name__}: {exc}",
            kind=_classify(exc),
        ) from exc

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
