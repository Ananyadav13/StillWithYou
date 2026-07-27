"""Structured JSON logging.

One line of JSON per event on stdout, so log lines are greppable now and
machine-parseable when they reach a collector later. Stdlib logging rather than
structlog — the only thing we need beyond the stdlib is a formatter, and a
dependency that buys one class is not worth carrying.

Every analysis event carries the same core fields:
    timestamp, level, event, message_id, latency_ms, outcome
"""

import json
import logging
import sys
import time
from datetime import datetime, timezone
from typing import Any, Literal

Outcome = Literal["success", "fallback", "error"]

LOGGER_NAME = "stillwithyou"

logger = logging.getLogger(LOGGER_NAME)


class JsonFormatter(logging.Formatter):
    """Render a record as a single JSON object.

    Structured fields ride in `record.structured` (populated by `log_event`) and
    are merged into the top level of the object, so `message_id` is a real field
    rather than something a downstream parser has to dig out of a nested dict.
    """

    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "timestamp": datetime.fromtimestamp(record.created, tz=timezone.utc).isoformat(),
            "level": record.levelname.lower(),
            "event": record.getMessage(),
        }
        payload.update(getattr(record, "structured", {}))

        if record.exc_info:
            payload["exc_info"] = self.formatException(record.exc_info)

        return json.dumps(payload, default=str)


def configure_logging(level: int = logging.INFO) -> None:
    """Attach the JSON handler. Safe to call more than once (worker + API both do)."""
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter())

    logger.handlers = [handler]
    logger.setLevel(level)
    # Don't propagate to root: uvicorn owns root's handlers and would print each
    # of our lines a second time in its own plain-text format.
    logger.propagate = False


def log_event(event: str, level: int = logging.INFO, **fields: Any) -> None:
    """Emit one structured line. `fields` become top-level keys in the JSON."""
    logger.log(level, event, extra={"structured": fields})


class track_analysis:
    """Time an analysis attempt and emit exactly one structured line for it.

    Used identically from the request path (Phase 1) and from the ARQ worker
    (Phase 2 Step 3 onward), so latency is always measured the same way.

        with track_analysis(message_id) as t:
            result = await analyze_message(content)
            t.success(source=result.source)
    """

    def __init__(self, message_id: Any, event: str = "analysis_attempt") -> None:
        self.message_id = str(message_id)
        self.event = event
        self._started = 0.0
        self._fields: dict[str, Any] = {}
        self._outcome: Outcome = "error"
        self._level = logging.ERROR

    @property
    def latency_ms(self) -> float:
        return round((time.perf_counter() - self._started) * 1000, 1)

    def __enter__(self) -> "track_analysis":
        self._started = time.perf_counter()
        return self

    def success(self, **fields: Any) -> None:
        self._outcome, self._level = "success", logging.INFO
        self._fields.update(fields)

    def fallback(self, **fields: Any) -> None:
        self._outcome, self._level = "fallback", logging.WARNING
        self._fields.update(fields)

    def error(self, **fields: Any) -> None:
        self._outcome, self._level = "error", logging.ERROR
        self._fields.update(fields)

    def __exit__(self, exc_type, exc, tb) -> bool:
        if exc_type is not None and self._outcome == "error" and not self._fields:
            self._fields["error"] = f"{exc_type.__name__}: {exc}"

        log_event(
            self.event,
            level=self._level,
            message_id=self.message_id,
            latency_ms=self.latency_ms,
            outcome=self._outcome,
            **self._fields,
        )
        return False
