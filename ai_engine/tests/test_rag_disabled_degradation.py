"""Regression: RAG-disabled must not fail study-plan / syllabus / research intents.

Production incident class: RAG_ENABLED defaults to false on the 512 MiB free
runtime (by design — embeddings need a larger instance). Before the fix, any
intent whose toolset includes retrieve_learning_materials failed the WHOLE
request with RAG_FAILED 503, so "make me a study plan" was broken on the very
deployment profile this repository targets. The database stays authoritative;
retrieval-disabled degrades the answer's grounding, not the request.
"""
import pytest

from agent.router import _run_tools  # noqa: F401  (existence check)
from agent.models import AgentState, Observation
from agent.tools.base import ToolRegistry, ToolDefinition


def _state() -> AgentState:
    return AgentState(goal="make me a study plan", conversation=[])


@pytest.mark.asyncio
async def test_rag_disabled_is_not_fatal(monkeypatch):
    """A retrieve_learning_materials RAG_DISABLED observation must not raise."""
    from agent import router

    class RagDisabledStub(RuntimeError):
        code = "RAG_DISABLED"

    async def fail_disabled2(arguments, context=None):
        raise RagDisabledStub("Semantic retrieval is disabled on this instance")

    fail_tool = ToolDefinition(
        name="retrieve_learning_materials",
        description="retrieval",
        input_schema={"type": "object", "properties": {"query": {"type": "string"}}, "required": [], "additionalProperties": False},
        executor=fail_disabled2,
        category="INTERNAL",
        permission="READ_INTERNAL",
        timeout_seconds=5,
    )

    async def ok_schedule(arguments, context=None):
        return {"sessions": [], "date": "2026-09-14"}

    ok_tool = ToolDefinition(
        name="get_today_schedule",
        description="schedule",
        input_schema={"type": "object", "properties": {}, "additionalProperties": False},
        executor=ok_schedule,
        category="INTERNAL",
        permission="READ_INTERNAL",
        timeout_seconds=5,
    )

    registry = ToolRegistry()
    registry.register(ok_tool)
    registry.register(fail_tool)

    state = _state()

    class _Events:
        async def emit(self, *a, **k):
            return None

    class _Sources:
        def add_web(self, *a, **k):
            return None

        def add_internal(self, *a, **k):
            return None

    observations = await router._run_tools(
        registry=registry,
        tools=("get_today_schedule", "retrieve_learning_materials"),
        subject=None,
        goal="plan my day",
        state=state,
        sources=_Sources(),
        events=_Events(),
        tool_context={"user_id": "u1"},
    )
    # Both observations recorded; the disabled retrieval is visible in context.
    assert len(observations) == 2
    retrieval = next(o for o in observations if o.tool == "retrieve_learning_materials")
    assert retrieval.success is False
    assert retrieval.error_code == "RAG_DISABLED"


@pytest.mark.asyncio
async def test_rag_real_failure_stays_fatal():
    """A genuine retrieval/index failure (RAG_FAILED) must still fail honestly."""
    from agent import router

    class RagFailedStub(RuntimeError):
        code = "RAG_FAILED"

    async def fail_index(arguments, context=None):
        raise RagFailedStub("Embedding model failed to load")

    fail_tool = ToolDefinition(
        name="retrieve_learning_materials",
        description="retrieval",
        input_schema={"type": "object", "properties": {"query": {"type": "string"}}, "required": [], "additionalProperties": False},
        executor=fail_index,
        category="INTERNAL",
        permission="READ_INTERNAL",
        timeout_seconds=5,
    )
    registry = ToolRegistry()
    registry.register(fail_tool)

    class _Events:
        async def emit(self, *a, **k):
            return None

    class _Sources:
        def add_web(self, *a, **k):
            return None

        def add_internal(self, *a, **k):
            return None

    from agent.llm import LLMResponseError

    with pytest.raises(LLMResponseError) as excinfo:
        await router._run_tools(
            registry=registry,
            tools=("retrieve_learning_materials",),
            subject=None,
            goal="plan my day",
            state=_state(),
            sources=_Sources(),
            events=_Events(),
            tool_context={"user_id": "u1"},
        )
    assert excinfo.value.error_type == "RAG_FAILED"
