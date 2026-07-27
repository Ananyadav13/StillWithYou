"""Circuit breaker around the Gemini call.

    CLOSED     -- calls pass through. 3 consecutive failures inside 30s trips it.
    OPEN       -- calls are refused immediately for 60s. No Gemini traffic at all.
    HALF_OPEN  -- exactly one probe call is admitted. Success closes the circuit,
                  failure re-opens it for another 60s.

State lives in Redis rather than in process memory for two reasons: it survives
worker restarts, and every worker instance sees the same circuit. A breaker held
in memory would let N workers each independently hammer a dependency that the
first one already found to be down.

The decision and the transition have to happen together — two workers reading
"open" and both electing themselves the probe would defeat the point — so each
operation is a single Lua script, executed atomically by Redis.
"""

import time
from typing import Literal

from app.core.logging import log_event
from app.core.redis import get_redis

CircuitState = Literal["closed", "open", "half_open"]

FAILURE_THRESHOLD = 3
FAILURE_WINDOW_SECONDS = 30
OPEN_DURATION_SECONDS = 60
# How long a single half-open probe may hold its slot before another is allowed.
PROBE_TTL_SECONDS = 10


# Returns {allowed, state, transition_reason}. A non-empty reason means this call
# caused a state change and the caller should log it.
_ALLOW_LUA = """
local state = redis.call('GET', KEYS[1]) or 'closed'
local now = tonumber(ARGV[1])
local open_duration = tonumber(ARGV[2])
local probe_ttl = tonumber(ARGV[3])

if state == 'closed' then
  return {1, 'closed', ''}
end

if state == 'open' then
  local opened_at = tonumber(redis.call('GET', KEYS[2]) or '0')
  if now - opened_at >= open_duration then
    redis.call('SET', KEYS[1], 'half_open')
    redis.call('SET', KEYS[3], '1', 'EX', probe_ttl)
    return {1, 'half_open', 'open_duration_elapsed'}
  end
  return {0, 'open', ''}
end

-- half_open: admit one probe at a time
local acquired = redis.call('SET', KEYS[3], '1', 'NX', 'EX', probe_ttl)
if acquired then
  return {1, 'half_open', ''}
end
return {0, 'half_open', ''}
"""

# Returns {state, transition_reason, consecutive_failures}.
_FAILURE_LUA = """
local state = redis.call('GET', KEYS[1]) or 'closed'
local now = ARGV[1]
local window = tonumber(ARGV[2])
local threshold = tonumber(ARGV[3])

if state == 'half_open' then
  redis.call('SET', KEYS[1], 'open')
  redis.call('SET', KEYS[2], now)
  redis.call('DEL', KEYS[3])
  redis.call('DEL', KEYS[4])
  return {'open', 'half_open_probe_failed', 0}
end

local failures = redis.call('INCR', KEYS[3])
if failures == 1 then
  redis.call('EXPIRE', KEYS[3], window)
end

if state == 'closed' and failures >= threshold then
  redis.call('SET', KEYS[1], 'open')
  redis.call('SET', KEYS[2], now)
  redis.call('DEL', KEYS[3])
  return {'open', 'failure_threshold_reached', failures}
end

return {state, '', failures}
"""

# Returns {state, transition_reason}.
_SUCCESS_LUA = """
local state = redis.call('GET', KEYS[1]) or 'closed'
redis.call('DEL', KEYS[2])

if state == 'half_open' then
  redis.call('SET', KEYS[1], 'closed')
  redis.call('DEL', KEYS[3])
  return {'closed', 'probe_succeeded'}
end

return {state, ''}
"""


class CircuitBreaker:
    def __init__(self, name: str = "gemini") -> None:
        self.name = name
        self._state_key = f"swy:cb:{name}:state"
        self._opened_at_key = f"swy:cb:{name}:opened_at"
        self._failures_key = f"swy:cb:{name}:failures"
        self._probe_key = f"swy:cb:{name}:probe"

    def _log_transition(self, from_state: str, to_state: str, reason: str) -> None:
        log_event(
            "circuit_breaker_transition",
            level=30,
            circuit=self.name,
            from_state=from_state,
            to_state=to_state,
            reason=reason,
        )

    async def state(self) -> CircuitState:
        raw = await get_redis().get(self._state_key)
        return raw or "closed"  # type: ignore[return-value]

    async def allow(self) -> tuple[bool, CircuitState]:
        """Decide whether a call may proceed, transitioning the circuit if due."""
        previous = await self.state()
        allowed, state, reason = await get_redis().eval(
            _ALLOW_LUA,
            3,
            self._state_key,
            self._opened_at_key,
            self._probe_key,
            str(time.time()),
            str(OPEN_DURATION_SECONDS),
            str(PROBE_TTL_SECONDS),
        )
        if reason:
            self._log_transition(previous, state, reason)
        return bool(allowed), state

    async def record_success(self) -> None:
        previous = await self.state()
        state, reason = await get_redis().eval(
            _SUCCESS_LUA,
            3,
            self._state_key,
            self._failures_key,
            self._probe_key,
        )
        if reason:
            self._log_transition(previous, state, reason)

    async def record_failure(self, failure_kind: str = "error") -> None:
        previous = await self.state()
        state, reason, failures = await get_redis().eval(
            _FAILURE_LUA,
            4,
            self._state_key,
            self._opened_at_key,
            self._failures_key,
            self._probe_key,
            str(time.time()),
            str(FAILURE_WINDOW_SECONDS),
            str(FAILURE_THRESHOLD),
        )
        if reason:
            self._log_transition(previous, state, f"{reason}:{failure_kind}")
        else:
            log_event(
                "circuit_breaker_failure_recorded",
                level=30,
                circuit=self.name,
                state=state,
                consecutive_failures=int(failures),
                failure_kind=failure_kind,
            )

    async def reset(self) -> None:
        """Force the circuit closed and clear counters. For tests and manual recovery."""
        await get_redis().delete(
            self._state_key, self._opened_at_key, self._failures_key, self._probe_key
        )

    async def force_open(self) -> None:
        """Force the circuit open. For failure-injection testing."""
        redis = get_redis()
        await redis.set(self._state_key, "open")
        await redis.set(self._opened_at_key, str(time.time()))
        self._log_transition("closed", "open", "forced_open")


gemini_breaker = CircuitBreaker("gemini")
