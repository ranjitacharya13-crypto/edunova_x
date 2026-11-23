"""Regression tests for the EduNova AI Master Fix in ai_engine:
1. /api/ai/health reports configured=True, status='healthy', searchConfigured=True,
   and full capabilities in default in-process GGUF topology (AI_INFERENCE_URL='').
2. IntentRouter classifies 'Analyze my last quiz.', subject queries,
   multi-day exam study plans, and verified research queries accurately.
3. run_fast_path renders full multi-day study schedules without truncating at Day 2
   and calls get_quiz_results when registered.
4. WebTools auto-mode falls back cleanly through keyless CrossRef and Wikipedia APIs.
"""

from __future__ import annotations

import asyncio
import sys
import types
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import main  # noqa: E402
from agent.router import IntentRouter, run_fast_path  # noqa: E402
from agent.tools.base import ToolDefinition, ToolRegistry  # noqa: E402
from agent.tools.web import WebTools  # noqa: E402
from config import load_settings  # noqa: E402
from inference.inprocess import InProcessLLM  # noqa: E402


class _ReadyInProcessStub(InProcessLLM):
    def __init__(self) -> None:
        pass

    async def probe(self, deep: bool = False) -> dict:
        return {
            "ready": True,
            "state": "MODEL_READY",
            "modelReady": True,
            "permanentFailure": False,
            "model": {"state": "MODEL_READY", "runtime": "llama.cpp"},
        }


class _ScriptedLLM:
    is_local = True

    def __init__(self, *, text: str = "Scripted answer.", payload: dict | None = None):
        self.text = text
        self.payload = payload or {}
        self.calls: list[dict] = []

    async def complete_text(self, *, system_prompt, user_prompt, max_output_tokens=None, temperature=None):
        self.calls.append({"kind": "text", "system_prompt": system_prompt, "user_prompt": user_prompt})
        return self.text

    async def complete_json(self, *, system_prompt, user_prompt, retries=2, max_output_tokens=None, json_schema=None):
        self.calls.append({"kind": "json", "system_prompt": system_prompt, "user_prompt": user_prompt})
        return self.payload


def test_ai_health_reports_configured_true_and_capabilities_in_inprocess_mode(monkeypatch):
    stub_llm = _ReadyInProcessStub()

    async def fake_inference_status(force: bool = False) -> dict:
        return {
            "ready": True,
            "state": "MODEL_READY",
            "modelReady": True,
            "model_loaded": True,
            "warmup_complete": True,
            "inference_test": True,
            "reachable": True,
            "permanentFailure": False,
            "model": {"state": "MODEL_READY", "runtime": "llama.cpp"},
        }

    fake_settings = types.SimpleNamespace(
        inference_url="",
        llm_provider="local",
        llm_configuration_error=None,
        ai_require_internal_token=False,
        ai_internal_token="",
        search_configured=True,
    )

    monkeypatch.setattr(main, "llm", stub_llm)
    monkeypatch.setattr(main, "_inference_status", fake_inference_status)
    monkeypatch.setattr(main, "settings", fake_settings)

    body = asyncio.run(main.ai_health(x_ai_internal_token=None, deep=False))

    assert body["success"] is True
    assert body["configured"] is True
    assert body["status"] == "healthy"
    assert body["modelReady"] is True
    assert body["searchConfigured"] is True
    assert body["capabilities"] == {
        "chat": True,
        "timetable": True,
        "subjects": True,
        "quizAnalysis": True,
        "studyPlanning": True,
        "research": True,
    }


def test_intent_router_classifies_last_quiz_subjects_plan_and_research():
    cfg = load_settings()
    router = IntentRouter(cfg)

    quiz_decision = router.classify("Analyze my last quiz.", [])
    assert quiz_decision.intent == "performance_analysis"
    assert "get_quiz_results" in quiz_decision.tools
    assert "get_quiz_history" in quiz_decision.tools

    subj_decision = router.classify("What subjects am I enrolled in?", [])
    assert subj_decision.intent == "subjects"
    assert set(subj_decision.tools) >= {"get_subjects", "get_syllabus", "get_progress"}

    plan_decision = router.classify("Create a 5-day exam study plan.", [])
    assert plan_decision.intent == "action_study_plan"
    assert set(plan_decision.tools) >= {"get_today_schedule", "get_exams", "get_progress", "get_syllabus"}

    research_decision = router.classify("Find verified research sources on spaced repetition.", [])
    assert research_decision.intent == "web_research"
    assert "web_search" in research_decision.tools


def test_fast_path_executes_quiz_results_and_renders_full_5_day_plan():
    cfg = load_settings()
    registry = ToolRegistry(
        allowed_permissions={"READ_INTERNAL", "WRITE_INTERNAL", "READ_EXTERNAL", "UTILITY"}
    )
    called: list[str] = []

    fixtures = {
        "get_quiz_results": {
            "hasResults": True,
            "quizTitle": "Optics Quiz",
            "subject": "Physics",
            "score": 40,
            "weakTopics": ["Snell's Law"],
            "strongTopics": ["Reflection"],
        },
        "get_quiz_history": {"totalAttempts": 1, "averageScore": 40, "quizzes": []},
        "get_progress": {"weakSubjects": [{"subject": "Physics", "averageScore": 40}], "subjects": []},
        "get_subjects": {"subjects": ["Physics", "Mathematics"]},
        "get_today_schedule": {"periods": [{"period": 1, "subject": "Physics"}], "liveSessions": []},
        "get_exams": {"exams": [{"title": "Physics Midterm", "subject": "Physics"}]},
        "get_timetable": {"schedule": {"Monday": [{"period": 1, "subject": "Physics"}]}},
        "get_assignments": {"assignments": []},
        "get_study_history": {"sessions": []},
        "get_syllabus": {"enrolledSubjects": ["Physics", "Mathematics"], "curriculumTopics": []},
        "retrieve_learning_materials": {"documents": []},
        "create_study_plan": {
            "pending": True,
            "requiresConfirmation": True,
            "confirmationToken": "tok-123",
            "toolName": "create_study_plan",
            "message": "Confirm to save your study plan.",
        },
    }

    for tool_name, sample_data in fixtures.items():
        is_write = tool_name.startswith("create_")

        async def _exec(args, context=None, _n=tool_name, _d=sample_data):
            called.append(_n)
            return _d

        registry.register(
            ToolDefinition(
                name=tool_name,
                description=f"Stub {tool_name}",
                input_schema={"type": "object", "properties": {}, "additionalProperties": True},
                executor=_exec,
                permission="WRITE_INTERNAL" if is_write else "READ_INTERNAL",
                category="INTERNAL",
            )
        )

    router = IntentRouter(cfg)

    quiz_llm = _ScriptedLLM(text="Optics Quiz breakdown: 40% score; review Snell's Law.")
    quiz_decision = router.classify("Analyze my last quiz.", [])
    quiz_payload = asyncio.run(
        run_fast_path(
            settings=cfg,
            llm=quiz_llm,
            registry=registry,
            decision=quiz_decision,
            goal="Analyze my last quiz.",
            conversation=[],
            conversation_id="conv-quiz-1",
            user_id="student-1",
            user_name="Alice",
        )
    )
    assert quiz_payload["success"] is True
    assert "get_quiz_results" in called
    combined_prompt = quiz_llm.calls[0]["system_prompt"] + "\n" + quiz_llm.calls[0]["user_prompt"]
    assert "Optics Quiz" in combined_prompt

    plan_llm = _ScriptedLLM(
        payload={
            "title": "5-Day Physics Midterm Plan",
            "subject": "Physics",
            "schedule": [
                {"day": f"Day {idx}", "subject": "Physics", "topic": f"Optics Part {idx}", "durationMinutes": 45}
                for idx in range(1, 6)
            ],
        }
    )
    plan_decision = router.classify("Create a 5-day exam study plan.", [])
    plan_res = asyncio.run(
        run_fast_path(
            settings=cfg,
            llm=plan_llm,
            registry=registry,
            decision=plan_decision,
            goal="Create a 5-day exam study plan.",
            conversation=[],
            conversation_id="conv-plan-1",
            user_id="student-1",
            user_name="Alice",
        )
    )
    answer_text = plan_res.get("message") or plan_res.get("reply") or ""
    assert "create_study_plan" in called
    for day_num in range(1, 6):
        assert f"Day {day_num}" in answer_text, f"Expected Day {day_num} in rendered study plan: {answer_text}"


def test_web_tools_auto_fallback_queries_crossref_and_wikipedia():
    cfg = load_settings()
    object.__setattr__(cfg, "web_search_api_key", "")
    object.__setattr__(cfg, "web_search_provider", "auto")

    web = WebTools(cfg)

    async def fake_ddg(_q, _c):
        return []

    async def fake_crossref(_q, _c):
        return [
            {
                "title": "Spaced Practice in STEM Education",
                "url": "https://doi.org/10.1177/1529100612453266",
                "snippet": "Psychological Science · DOI: 10.1177/1529100612453266",
                "publishedDate": "2013",
            }
        ]

    async def fake_wiki(_q, _c):
        return [
            {
                "title": "Spaced repetition",
                "url": "https://en.wikipedia.org/wiki/Spaced_repetition",
                "snippet": "Evidence-based learning with expanding intervals.",
                "publishedDate": None,
            }
        ]

    web._search_duckduckgo = fake_ddg  # type: ignore[method-assign]
    web._search_crossref = fake_crossref  # type: ignore[method-assign]
    web._search_wikipedia = fake_wiki  # type: ignore[method-assign]

    # Step 1: DuckDuckGo empty -> CrossRef succeeds
    result_cr = asyncio.run(web.web_search({"query": "spaced repetition", "maxResults": 4}))
    assert len(result_cr["results"]) == 1
    assert result_cr["results"][0]["url"] == "https://doi.org/10.1177/1529100612453266"

    # Step 2: CrossRef also empty -> Wikipedia fallback succeeds
    async def empty_crossref(_q, _c):
        return []

    web._search_crossref = empty_crossref  # type: ignore[method-assign]
    result_wiki = asyncio.run(web.web_search({"query": "spaced repetition", "maxResults": 4}))
    assert len(result_wiki["results"]) == 1
    assert result_wiki["results"][0]["url"] == "https://en.wikipedia.org/wiki/Spaced_repetition"
