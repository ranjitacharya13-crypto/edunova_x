"""In-process owned-model engine contracts.

The orchestrator must OWN exactly one model lifecycle, expose the same
interface the planner/router already consume, and never fake readiness.
No model download is required: these tests exercise the supervisor states,
the status mapping and the single-flight admission guarantees.

Run: python -m pytest ai_engine/tests/test_inprocess_llm.py -q
"""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path
from unittest.mock import patch

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from agent.llm import LLMResponseError
from config import Settings
from inference.inprocess import InProcessLLM
from inference.manager import ModelManager


def _engine() -> InProcessLLM:
    return InProcessLLM(Settings())


def test_status_reports_a_live_starting_state_without_raising():
    engine = _engine()  # lifecycle not started
    status = asyncio.run(engine.status())
    assert status["reachable"] is True
    assert status["mode"] == "in-process"
    assert status["state"] in {"MODEL_NOT_READY", "MODEL_LOADING"}
    assert status["model_loaded"] is False
    assert engine.last_status_at is not None


def test_ready_requires_full_lifecycle_not_just_a_live_process():
    engine = _engine()
    status = asyncio.run(engine.status())
    with pytest.raises(LLMResponseError) as exc:
        asyncio.run(engine.probe(deep=False))
    assert exc.value.status_code == 503
    assert "not ready" in str(exc.value).lower() or "starting" in str(exc.value).lower()
    assert status["inference_test"] is False


def test_permanent_failure_is_surfaced_with_its_stage():
    engine = _engine()
    # Simulate a terminal resource failure exactly as the supervisor reports it.
    engine.manager._transition("MODEL_RESOURCE_INSUFFICIENT", {
        "lastError": "needs 460 MiB but has 512 MiB limit minus overhead", "failureStage": "BOOT"})
    status = asyncio.run(engine.status())
    assert status["state"] == "MODEL_FAILED"
    assert status["permanentFailure"] is True
    assert status["errorStage"] == "MODEL_RESOURCE_INSUFFICIENT"
    with pytest.raises(LLMResponseError) as exc:
        asyncio.run(engine.probe())
    assert exc.value.error_type == "MODEL_RESOURCE_INSUFFICIENT"


@pytest.mark.asyncio
async def test_start_is_idempotent_and_single_lifecycle():
    engine = _engine()
    with patch.object(engine.manager, "ensure_loading", wraps=engine.manager.ensure_loading) as once:
        engine.start()
        engine.start()
        engine.start()
        assert once.call_count == 3
    await engine.close()


@pytest.mark.asyncio
async def test_start_never_restarts_a_failed_lifecycle():
    engine = _engine()
    engine.manager._transition("OUT_OF_MEMORY", {"lastError": "capacity", "failureStage": "BOOT"})
    engine.manager._started = True
    process = engine.manager._process  # None for a terminal lifecycle
    engine.start()
    assert engine.manager._process is process
    assert engine.manager.phase == "OUT_OF_MEMORY"


@pytest.mark.asyncio
async def test_generate_refuses_to_fabricate_when_not_ready():
    engine = _engine()
    with pytest.raises(LLMResponseError) as exc:
        await engine.complete_text(system_prompt="s", user_prompt="q", max_output_tokens=8)
    assert exc.value.status_code == 503


@pytest.mark.asyncio
async def test_generate_reports_busy_style_errors_from_the_supervisor():
    engine = _engine()
    engine.manager._transition("READY", {"modelLoaded": True, "tokenizerLoaded": True,
                                         "warmupComplete": True, "inferenceTest": True})
    # manager.is_ready() also requires a live worker process; simulate absent process.
    async def refuse(**kwargs):
        raise LLMResponseError("Model startup has not completed", status_code=503, error_type="MODEL_NOT_READY")
    with patch.object(engine.manager, "generate", side_effect=refuse):
        with pytest.raises(LLMResponseError):
            await engine.complete_text(system_prompt="s", user_prompt="q", max_output_tokens=8)


@pytest.mark.asyncio
async def test_complete_json_parses_a_grammar_valid_answer():
    engine = _engine()
    engine.manager._transition("READY", {"modelLoaded": True, "tokenizerLoaded": True,
                                         "warmupComplete": True, "inferenceTest": True})
    async def fake_generate(**kwargs):
        assert kwargs["json_schema"] is not None
        return '{"action": "final", "answer": "ok"}'
    with patch.object(engine.manager, "generate", side_effect=fake_generate), \
         patch.object(engine.manager, "is_ready", return_value=True):
        decision = await engine.complete_json(system_prompt="s", user_prompt="q")
    assert decision == {"action": "final", "answer": "ok"}


@pytest.mark.asyncio
async def test_complete_json_retries_invalid_output_then_raises():
    engine = _engine()
    engine.manager._transition("READY", {"modelLoaded": True, "tokenizerLoaded": True,
                                         "warmupComplete": True, "inferenceTest": True})
    calls = {"n": 0}
    async def fake_generate(**kwargs):
        calls["n"] += 1
        return "not json at all"
    with patch.object(engine.manager, "generate", side_effect=fake_generate), \
         patch.object(engine.manager, "is_ready", return_value=True):
        with pytest.raises(LLMResponseError):
            await engine.complete_json(system_prompt="s", user_prompt="q", retries=2)
    assert calls["n"] == 3  # 1 attempt + 2 retries, then an honest failure
