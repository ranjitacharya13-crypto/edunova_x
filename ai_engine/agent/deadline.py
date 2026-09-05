"""ONE coordinated request deadline for the whole EduNova AI request.

Why this module exists
----------------------
Before this, every layer had its own independent timeout:

    frontend  : none (browser default)
    Express   : AGENT_REQUEST_TIMEOUT = 210s, AGENT_STREAM_TIMEOUT_MS = 240s
    FastAPI   : MAX_AGENT_RUNTIME_SECONDS = 180s
    llama.cpp : none at all — it generated until `max_tokens` was reached

Nothing in that ladder bounded a *single* request to a human timescale, and the
innermost layer (token generation) had no deadline whatsoever. A simple
question such as "what is ml" was allowed to decode up to 640 tokens; on a
shared Render CPU at a few tokens/second that is minutes of wall clock, so the
outer 180s guard fired and the student saw
"EduNova AI took too long to respond."

The fix is a single budget, set once at the HTTP boundary and inherited by
everything downstream through a ContextVar. ContextVars are copied into
``asyncio.to_thread`` workers, so the llama.cpp generation loop — which runs in
a worker thread — sees the same deadline as the request handler without
threading an extra argument through every call site (planner, fast path, tool
synthesis, JSON generation).

Semantics
---------
* The deadline is an absolute ``time.monotonic()`` instant, not a duration, so
  it does not drift as it is passed down through layers.
* ``remaining()`` is what callers use to size their own sub-operations.
* Generation checks the deadline between tokens and stops cleanly, returning
  the text produced so far, rather than being cancelled mid-decode. A slightly
  shorter answer delivered in time beats a perfect answer the student never
  sees — and, critically, a clean stop releases the llama.cpp lock instead of
  leaking a runaway worker thread (see PART 17: model deadlocks).
"""

from __future__ import annotations

import contextvars
import time

# Absolute monotonic instant by which the current request must be finished.
# ``None`` means "no deadline" (used by tests, warmup and the self-test).
_DEADLINE: contextvars.ContextVar[float | None] = contextvars.ContextVar(
    "edunova_request_deadline", default=None
)


def set_deadline(seconds: float | None) -> contextvars.Token:
    """Start a budget of ``seconds`` from now. Returns a reset token."""
    if seconds is None:
        return _DEADLINE.set(None)
    return _DEADLINE.set(time.monotonic() + max(0.5, float(seconds)))


def reset_deadline(token: contextvars.Token) -> None:
    try:
        _DEADLINE.reset(token)
    except ValueError:
        # The token belongs to a different context (e.g. it was created in the
        # request task and reset from a callback). Losing the reset is safe:
        # the ContextVar dies with the context.
        pass


def deadline_at() -> float | None:
    """Absolute monotonic instant of the current deadline, if any."""
    return _DEADLINE.get()


def remaining() -> float | None:
    """Seconds left in the budget, or ``None`` when unbounded. Never negative."""
    at = _DEADLINE.get()
    if at is None:
        return None
    return max(0.0, at - time.monotonic())


def expired(safety_margin: float = 0.0) -> bool:
    """True when the budget is exhausted (optionally ``safety_margin`` early).

    ``safety_margin`` lets an inner stage stop early enough that the outer
    stages still have time to serialize and flush the response.
    """
    at = _DEADLINE.get()
    if at is None:
        return False
    return time.monotonic() >= (at - max(0.0, safety_margin))


def tighten(seconds: float) -> None:
    """Bring the deadline FORWARD to at most ``seconds`` from now.

    Used by the intent router to give cheap requests a tighter target than the
    global budget (PART 12): a greeting or a one-line definition should finish
    in a few seconds, not consume the full 20s just because it is available.
    It can only ever shorten the budget — never extend it — so no intent can
    escape the request-wide ceiling set at the HTTP boundary.
    """
    at = _DEADLINE.get()
    if at is None:
        return
    proposed = time.monotonic() + max(0.5, float(seconds))
    if proposed < at:
        _DEADLINE.set(proposed)


def budget_for(share: float, *, floor: float, ceiling: float) -> float:
    """Size a sub-operation as a fraction of what is left of the budget.

    Used by tool execution and web search so a slow dependency can never eat
    the whole request: they get a slice, and generation keeps the rest.
    """
    left = remaining()
    if left is None:
        return ceiling
    return max(floor, min(ceiling, left * max(0.0, min(1.0, share))))
