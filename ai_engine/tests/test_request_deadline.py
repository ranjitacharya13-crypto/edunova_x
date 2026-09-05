"""Tests for the ONE coordinated request deadline (PART 12/13/15/17).

These cover the actual production failure: a simple question ("what is ml")
was allowed to decode without any time bound, blew past the outer guard, and
surfaced as "EduNova AI took too long to respond."

The tests below assert the properties that make that impossible now:
  * generation stops cooperatively at the deadline and returns real text;
  * the deadline reaches the llama.cpp worker thread through the ContextVar;
  * token budgets shrink to what the remaining time can actually decode;
  * short questions get short budgets, detailed ones keep long budgets;
  * a deadline stop is never retried and never silently faked.
"""

from __future__ import annotations

import asyncio
from pathlib import Path
import sys
import time

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from agent import deadline as request_deadline  # noqa: E402
from agent.llm import LLMResponseError  # noqa: E402
from agent.local_llm import LocalModelManager  # noqa: E402
from agent.router import _answer_token_budget  # noqa: E402
from config import load_settings  # noqa: E402


@pytest.fixture(autouse=True)
def _clear_deadline():
    token = request_deadline.set_deadline(None)
    yield
    request_deadline.reset_deadline(token)


# --------------------------------------------------------------- deadline --
def test_remaining_is_none_without_deadline():
    assert request_deadline.remaining() is None
    assert request_deadline.expired() is False


def test_remaining_counts_down_and_floors_at_zero():
    request_deadline.set_deadline(0.5)
    first = request_deadline.remaining()
    assert first is not None and 0 < first <= 0.5
    time.sleep(0.6)
    assert request_deadline.remaining() == 0.0
    assert request_deadline.expired() is True


def test_safety_margin_expires_early():
    request_deadline.set_deadline(1.0)
    assert request_deadline.expired() is False
    # With a 5s margin, a 1s budget is already considered spent.
    assert request_deadline.expired(safety_margin=5.0) is True


def test_budget_for_takes_a_slice_and_respects_bounds():
    request_deadline.set_deadline(20)
    slice_s = request_deadline.budget_for(0.5, floor=2.0, ceiling=12.0)
    assert 9.0 <= slice_s <= 10.0  # ~half of what remains
    # Floor applies when almost nothing is left.
    request_deadline.set_deadline(0.6)
    assert request_deadline.budget_for(0.5, floor=2.0, ceiling=12.0) == 2.0
    # Ceiling applies when there is plenty.
    request_deadline.set_deadline(120)
    assert request_deadline.budget_for(0.9, floor=2.0, ceiling=12.0) == 12.0


def test_deadline_propagates_into_worker_threads():
    """ContextVars are copied into asyncio.to_thread — this is what lets the
    budget set at the HTTP boundary reach the llama.cpp generation loop."""

    async def scenario():
        request_deadline.set_deadline(30)
        return await asyncio.to_thread(request_deadline.remaining)

    seen = asyncio.run(scenario())
    assert seen is not None and seen > 25


# ------------------------------------------------------- token budgeting --
def test_short_question_gets_a_short_token_budget():
    settings = load_settings()
    small = _answer_token_budget(settings, "what is ml", base=640)
    assert small <= 320, "a definitional question must not request 640 tokens"


def test_greeting_gets_the_smallest_budget():
    settings = load_settings()
    assert _answer_token_budget(settings, "hello", base=640) <= 96


def test_detailed_request_keeps_the_large_budget():
    settings = load_settings()
    big = _answer_token_budget(settings, "compare python and java in detail", base=640)
    small = _answer_token_budget(settings, "what is ml", base=640)
    assert big > small


def test_token_budget_never_exceeds_the_configured_ceiling():
    settings = load_settings()
    budget = _answer_token_budget(settings, "explain everything in full detail", base=100_000)
    assert budget <= settings.llm_max_output_tokens


def test_budgeted_max_tokens_shrinks_to_the_time_available():
    manager = LocalModelManager(load_settings())
    manager._tokens_per_second = 10.0
    request_deadline.set_deadline(6.0)
    # ~4.5 usable seconds at 10 tok/s => roughly 45 tokens, floored to 48.
    assert manager._budgeted_max_tokens(640, json_schema=None) <= 64


def test_budgeted_max_tokens_is_unbounded_without_a_deadline():
    manager = LocalModelManager(load_settings())
    assert manager._budgeted_max_tokens(640, json_schema=None) == 640


def test_json_generation_is_exempt_from_shrinking():
    """A truncated JSON object is unparseable, so shrinking it guarantees
    failure. Better to attempt the full length and fail cleanly."""
    manager = LocalModelManager(load_settings())
    manager._tokens_per_second = 10.0
    request_deadline.set_deadline(2.0)
    assert manager._budgeted_max_tokens(640, json_schema={"type": "object"}) == 640


def test_throughput_estimate_calibrates_from_real_measurements():
    manager = LocalModelManager(load_settings())
    assert manager._tokens_per_second is None
    manager._record_throughput(100, 5.0)  # 20 tok/s
    assert manager._tokens_per_second == pytest.approx(20.0)
    manager._record_throughput(100, 10.0)  # 10 tok/s, blended via EMA
    assert 10.0 < manager._tokens_per_second < 20.0


def test_throughput_ignores_tiny_samples():
    """Short bursts are dominated by prompt-eval and would skew the estimate."""
    manager = LocalModelManager(load_settings())
    manager._record_throughput(3, 2.0)
    assert manager._tokens_per_second is None


# ------------------------------------------- cooperative generation stop --
class _SlowLlama:
    """A stand-in llama.cpp that emits a token every ``delay`` seconds."""

    def __init__(self, delay: float = 0.05, total: int = 10_000):
        self.delay = delay
        self.total = total
        self.emitted = 0

    def n_ctx(self):
        return 4096

    def tokenize(self, text, add_bos=True, special=True):
        return [0] * (len(text) // 4 + 1)

    def create_completion(self, **kwargs):
        def _gen():
            for _ in range(self.total):
                time.sleep(self.delay)
                self.emitted += 1
                yield {"choices": [{"text": "word "}]}

        return _gen()


def _manager_with(llama):
    manager = LocalModelManager(load_settings())
    manager._llama = llama
    manager.state = "ready"
    return manager


def test_generation_stops_at_the_deadline_and_returns_partial_text():
    """The core regression: an unbounded decode loop is what produced the
    production timeout. It must now stop on its own and return real text."""
    llama = _SlowLlama(delay=0.02)
    manager = _manager_with(llama)

    async def scenario():
        # 4s budget, 1.5s flush margin => ~2.5s of actual generation.
        request_deadline.set_deadline(4.0)
        started = time.monotonic()
        text = await manager.generate(
            system_prompt="sys",
            user_prompt="what is machine learning?",
            max_tokens=100_000,
        )
        return text, time.monotonic() - started

    text, elapsed = asyncio.run(scenario())
    assert "word" in text, "partial but genuine model output must be returned"
    assert "shortened" in text, "a truncated answer must say so, never pretend to be complete"
    assert elapsed < 4.0, f"generation ignored the deadline (took {elapsed:.1f}s)"
    assert llama.emitted < 10_000, "the decode loop ran to completion despite the deadline"


def test_generation_without_a_deadline_runs_to_completion():
    """No deadline (tests, warmup, self-test) must not change behaviour."""
    llama = _SlowLlama(delay=0.0, total=5)
    manager = _manager_with(llama)
    text = asyncio.run(
        manager.generate(system_prompt="sys", user_prompt="hi", max_tokens=50)
    )
    assert text.strip() == "word word word word word"
    assert "shortened" not in text


def test_truncated_json_fails_honestly_instead_of_returning_broken_output():
    llama = _SlowLlama(delay=0.02)
    manager = _manager_with(llama)

    async def scenario():
        request_deadline.set_deadline(4.0)
        return await manager.generate(
            system_prompt="sys",
            user_prompt="make a quiz",
            max_tokens=100_000,
            json_schema={"type": "object"},
        )

    with pytest.raises(LLMResponseError) as excinfo:
        asyncio.run(scenario())
    assert excinfo.value.error_type == "deadline_exceeded"
    assert excinfo.value.status_code == 504


def test_lock_wait_is_bounded_by_the_deadline_not_300_seconds():
    """A queued request must fail fast as MODEL_BUSY rather than wait five
    minutes behind another generation and then still need to generate."""
    manager = _manager_with(_SlowLlama())
    manager._llama_thread_lock.acquire()  # simulate a generation in flight
    try:
        async def scenario():
            request_deadline.set_deadline(2.0)
            return await asyncio.to_thread(
                manager._generate_sync_protected, "sys", "user", 64, 0.2, None, False, None
            )

        started = time.monotonic()
        with pytest.raises(LLMResponseError) as excinfo:
            asyncio.run(scenario())
        elapsed = time.monotonic() - started
        assert excinfo.value.error_type == "model_busy"
        assert elapsed < 5, f"waited {elapsed:.1f}s for the lock; must be deadline-bounded"
    finally:
        manager._llama_thread_lock.release()


def test_real_tokens_are_streamed_to_the_callback_as_they_decode():
    """Streaming must be genuine: pieces arrive during generation, not after."""
    llama = _SlowLlama(delay=0.0, total=6)
    manager = _manager_with(llama)
    seen: list[str] = []

    text = asyncio.run(
        manager.generate(
            system_prompt="sys",
            user_prompt="hi",
            max_tokens=50,
            on_token=seen.append,
        )
    )
    assert len(seen) == 6, "every decoded piece must reach the token callback"
    assert "".join(seen).strip() == text.strip()


# --------------------------------------------------- per-intent tiering --
def test_intent_deadline_tightens_simple_questions():
    """A definition must not be allowed to spend the full 20s just because it
    is available (PART 12: simple questions target 2-8s)."""
    from agent.router import apply_intent_deadline

    request_deadline.set_deadline(20)
    apply_intent_deadline("knowledge")
    left = request_deadline.remaining()
    assert left is not None and left <= 9.5


def test_intent_deadline_never_extends_the_request_budget():
    """Tightening is one-way: no intent may escape the request-wide ceiling."""
    from agent.router import apply_intent_deadline

    request_deadline.set_deadline(5)
    apply_intent_deadline("web_research")  # target is 19s, far more than 5s
    left = request_deadline.remaining()
    assert left is not None and left <= 5.0


def test_intent_deadline_is_a_noop_without_a_deadline():
    from agent.router import apply_intent_deadline

    apply_intent_deadline("knowledge")
    assert request_deadline.remaining() is None


def test_queued_request_with_no_time_left_fails_as_busy_not_as_a_stub():
    """Emitting one token because the budget was spent queueing is worse than
    useless — it looks like a real answer. It must be an honest MODEL_BUSY."""
    manager = _manager_with(_SlowLlama())

    async def scenario():
        request_deadline.set_deadline(1.6)  # under flush margin + 1s
        return await asyncio.to_thread(
            manager._generate_sync_protected, "sys", "user", 64, 0.2, None, False, None
        )

    with pytest.raises(LLMResponseError) as excinfo:
        asyncio.run(scenario())
    assert excinfo.value.error_type == "model_busy"
