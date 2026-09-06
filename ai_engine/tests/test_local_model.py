"""Tests for the self-hosted local model runtime and deterministic fast paths.

Covers:
1. Local provider configuration (no external API key required)
2. Intent routing for the six canonical acceptance questions
3. Fast-path execution (DB tools, web tools, conversation context, actions)
4. LocalLlamaLLM against a fake llama_cpp module (prompt, grammar, parsing)
5. Failure honesty: a missing/loading model raises real errors, never fakes

Run: python -m unittest ai_engine/tests/test_local_model.py -v
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from agent.llm import LLMResponseError  # noqa: E402
from agent.local_llm import DECISION_SCHEMA, LocalModelManager  # noqa: E402
from agent.remote_llm import RemoteInferenceLLM, create_llm  # noqa: E402
from inference.resources import ResourceInsufficient, check_model_fits, estimate_requirement  # noqa: E402
from agent.router import (  # noqa: E402
    IntentRouter,
    RouteDecision,
    run_fast_path,
    validate_plan_payload,
    validate_quiz_payload,
)
from agent.tools.base import ToolDefinition, ToolRegistry  # noqa: E402
from config import Settings, load_settings  # noqa: E402


def local_settings(**overrides) -> Settings:
    base = dict(
        llm_provider="local",
        llm_max_output_tokens=900,
        llm_temperature=0.2,
        max_agent_iterations=5,
        max_tool_calls=8,
        max_agent_runtime_seconds=60,
        agent_max_context_chars=24_000,
        conversation_max_turns=4,
        conversation_ttl_seconds=3600,
        local_preload_model=True,
        local_chat_wait_seconds=2,
    )
    base.update(overrides)
    return Settings(**base)


class LocalProviderConfigTests(unittest.TestCase):
    def test_local_provider_needs_no_api_key(self):
        prev = os.getenv("LLM_PROVIDER")
        try:
            os.environ.pop("LLM_API_KEY", None)
            os.environ["LLM_PROVIDER"] = "local"
            settings = load_settings()
            self.assertEqual(settings.llm_provider, "local")
            self.assertTrue(settings.llm_configured)
            self.assertIsNone(settings.llm_configuration_error)
            diag = settings.llm_safe_diagnostics()
            self.assertTrue(diag["selfHosted"])
            self.assertFalse(diag["apiKeyRequired"])
            self.assertIn("Qwen2.5-0.5B-Instruct", diag["local_model_id"])
        finally:
            if prev is None:
                os.environ.pop("LLM_PROVIDER", None)
            else:
                os.environ["LLM_PROVIDER"] = prev

    def test_provider_aliases_normalize_to_local(self):
        prev = os.getenv("LLM_PROVIDER")
        try:
            for alias in ("selfhosted", "gguf", "llamacpp"):
                os.environ["LLM_PROVIDER"] = alias
                self.assertEqual(load_settings().llm_provider, "local")
        finally:
            if prev is None:
                os.environ.pop("LLM_PROVIDER", None)
            else:
                os.environ["LLM_PROVIDER"] = prev

    def test_missing_model_source_is_configuration_error(self):
        settings = local_settings(local_model_repo="", local_model_file="", local_model_url="")
        self.assertFalse(settings.llm_configured)
        self.assertEqual(settings.llm_configuration_error, "missing_model_source")

    def test_http_allowed_only_for_private_hosts(self):
        # Self-hosted gateway on the same host is a legitimate openai_compatible use.
        ok = Settings(llm_provider="openai_compatible", llm_api_key="k", llm_model="m", llm_base_url="http://127.0.0.1:11434/v1")
        self.assertIsNone(ok.llm_configuration_error)
        insecure = Settings(llm_provider="openai_compatible", llm_api_key="k", llm_model="m", llm_base_url="http://llm.example.com/v1")
        self.assertEqual(insecure.llm_configuration_error, "insecure_base_url")

    def test_diagnostics_never_expose_secrets(self):
        settings = local_settings(local_model_url="https://user:pass@example.com/model.gguf")
        diag = json.dumps(settings.llm_safe_diagnostics())
        self.assertNotIn("pass", settings.local_model_id)
        self.assertNotIn("user:pass", diag)
        self.assertNotIn("example.com/model.gguf", diag)  # only host + filename

    def test_create_llm_factory_returns_remote_inference_client(self):
        """The orchestrator never builds an in-process model: only the remote client."""
        settings = local_settings(inference_url="http://inference:8002")
        llm = create_llm(settings)
        self.assertIsInstance(llm, RemoteInferenceLLM)
        self.assertTrue(llm.is_local)
        self.assertEqual(llm.base_url, "http://inference:8002")

    def test_orchestrator_modules_never_import_model_runtimes(self):
        """Layer A must stay lightweight: no llama_cpp / torch imports at module level."""
        import ast
        for name in ("agent/remote_llm.py", "agent/engine.py", "agent/router.py", "main.py"):
            tree = ast.parse((Path(__file__).resolve().parents[1] / name).read_text())
            for node in ast.walk(tree):
                if isinstance(node, (ast.Import, ast.ImportFrom)):
                    mods = [n.name for n in node.names] if isinstance(node, ast.Import) else [node.module or ""]
                    for mod in mods:
                        self.assertFalse(mod.split(".")[0] in {"llama_cpp", "torch", "transformers"}, f"{name} imports {mod}")


class IntentRouterTests(unittest.TestCase):
    def setUp(self):
        self.router = IntentRouter(local_settings())

    def test_what_is_machine_learning_is_knowledge(self):
        decision = self.router.classify("What is machine learning?", [])
        self.assertEqual(decision.intent, "knowledge")
        self.assertEqual(decision.tools, ())

    def test_follow_up_uses_conversation_context(self):
        conversation = [
            {"role": "user", "content": "What is machine learning?"},
            {"role": "assistant", "content": "Machine learning is ..."},
        ]
        decision = self.router.classify("Explain it simply.", conversation)
        self.assertEqual(decision.intent, "knowledge")
        self.assertEqual(decision.reason, "follow-up uses conversation context")

    def test_classes_today_uses_database_not_web(self):
        decision = self.router.classify("What classes do I have today?", [])
        self.assertEqual(decision.intent, "schedule_today")
        self.assertIn("get_today_schedule", decision.tools)
        self.assertNotIn("web_search", decision.tools)

    def test_study_duration_uses_authenticated_history(self):
        decision = self.router.classify("How much did I study this week?", [])
        self.assertEqual(decision.intent, "study_history")
        self.assertEqual(decision.tools, ("get_study_history",))

    def test_weakest_subject_uses_performance_data(self):
        decision = self.router.classify("What is my weakest subject?", [])
        self.assertEqual(decision.intent, "performance_analysis")
        self.assertIn("get_quiz_history", decision.tools)
        self.assertIn("get_progress", decision.tools)

    def test_study_today_is_multi_source(self):
        decision = self.router.classify("What should I study today?", [])
        self.assertEqual(decision.intent, "study_recommendation")
        self.assertIn("get_today_schedule", decision.tools)
        self.assertIn("get_quiz_history", decision.tools)
        self.assertIn("get_assignments", decision.tools)

    def test_create_quiz_from_today_class_is_action(self):
        decision = self.router.classify("Create a quiz from today's class.", [])
        self.assertEqual(decision.intent, "action_create_quiz")
        self.assertIn("get_today_schedule", decision.tools)

    def test_latest_ai_news_is_web_research(self):
        decision = self.router.classify("What are the latest developments in AI?", [])
        self.assertEqual(decision.intent, "web_research")
        self.assertIn("web_search", decision.tools)

    def test_student_news_stays_internal(self):
        # "today" + student context must NOT be sent to the web.
        decision = self.router.classify("any new assignments today?", [])
        self.assertNotEqual(decision.intent, "web_research")

    def test_complex_task_falls_back_to_full_loop(self):
        decision = self.router.classify(
            "Compare my physics quiz trend with the syllabus chapters uploaded and draft a full revision strategy with links to my recordings, then schedule reminders.",
            [],
        )
        self.assertEqual(decision.intent, "complex")


class _ScriptedLLM:
    """Records prompts; returns scripted text/JSON. Never used for decisions."""

    is_local = True

    def __init__(self, *, text: str = "Scripted answer.", payload: dict | None = None, fail: Exception | None = None):
        self.text = text
        self.payload = payload or {}
        self.fail = fail
        self.calls: list[dict] = []

    async def complete_text(self, *, system_prompt, user_prompt, max_output_tokens=None, temperature=None):
        self.calls.append({"kind": "text", "system_prompt": system_prompt, "user_prompt": user_prompt})
        if self.fail:
            raise self.fail
        return self.text

    async def complete_json(self, *, system_prompt, user_prompt, retries=2, max_output_tokens=None, json_schema=None):
        self.calls.append({"kind": "json", "system_prompt": system_prompt, "user_prompt": user_prompt, "json_schema": json_schema})
        if self.fail:
            raise self.fail
        return self.payload


def _registry_with_fixtures(*names: str) -> tuple[ToolRegistry, list[dict]]:
    registry = ToolRegistry(
        allowed_permissions={"READ_INTERNAL", "WRITE_INTERNAL", "READ_EXTERNAL", "UTILITY"}
    )
    calls: list[dict] = []

    def make(name):
        async def fixture(args, context=None):
            calls.append({"name": name, "args": args, "context": context})
            if name == "web_search":
                return {
                    "query": args.get("query", ""),
                    "results": [
                        {"title": "AI Index Report 2025", "url": "https://hai.stanford.edu/ai-index", "snippet": "Annual report tracking AI progress.", "publishedDate": "2025-04-01"},
                        {"title": "Frontier model releases", "url": "https://example.org/frontier", "snippet": "New open-weight model releases."},
                    ],
                }
            if name == "save_quiz":
                return {
                    "pending": True,
                    "requiresConfirmation": True,
                    "confirmationToken": "token-123",
                    "toolName": "save_quiz",
                    "message": "Confirm to apply save quiz to EduNova.",
                    "arguments": args,
                }
            if name == "create_study_plan":
                return {
                    "pending": True,
                    "requiresConfirmation": True,
                    "confirmationToken": "token-456",
                    "toolName": "create_study_plan",
                    "message": "Confirm to apply create study plan to EduNova.",
                }
            if name == "get_today_schedule":
                return {"periods": [{"subject": "Physics", "topic": "Force", "period": 1}], "liveSessions": []}
            return {"fixture": name, "arguments": args}

        category = "EXTERNAL" if name in {"web_search", "open_url", "extract_webpage"} else "INTERNAL"
        permission = "READ_EXTERNAL" if category == "EXTERNAL" else (
            "WRITE_INTERNAL" if name.startswith(("create_", "save_", "mark_", "update_", "set_")) else "READ_INTERNAL"
        )
        return ToolDefinition(
            name=name,
            description=f"fixture {name}",
            input_schema={"type": "object", "properties": {}, "additionalProperties": True},
            executor=fixture,
            permission=permission,
            category=category,
        )

    for name in names:
        registry.register(make(name))
    return registry, calls


class FastPathTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.settings = local_settings()

    async def _run(self, message, conversation=(), tools=(), llm=None, decision=None, decision_tools=None):
        tool_names = tools or ("get_today_schedule", "get_quiz_history", "get_progress", "get_subjects",
                               "web_search", "save_quiz", "create_study_plan", "get_syllabus",
                               "get_learning_materials", "get_assignments", "get_study_history", "get_exams", "retrieve_learning_materials")
        registry, calls = _registry_with_fixtures(*tool_names)
        router = IntentRouter(self.settings)
        dec = decision or router.classify(message, list(conversation))
        if decision_tools is not None:
            dec = RouteDecision(intent=dec.intent, tools=decision_tools, subject=dec.subject, reason=dec.reason)
        llm = llm or _ScriptedLLM(text="Synthesized answer from local model.")
        payload = await run_fast_path(
            settings=self.settings,
            llm=llm,
            registry=registry,
            decision=dec,
            goal=message,
            conversation=list(conversation),
            conversation_id="conv-local-0001",
            user_id="student-42",
            user_name="Test Student",
        )
        return payload, calls, llm, dec

    async def test_knowledge_answer_uses_conversation_context(self):
        conversation = [
            {"role": "user", "content": "What is machine learning?"},
            {"role": "assistant", "content": "Machine learning is a branch of AI..."},
        ]
        payload, _, llm, decision = await self._run("Explain it simply.", conversation=conversation)
        self.assertEqual(decision.intent, "knowledge")
        self.assertTrue(payload["success"])
        self.assertFalse(payload["usedWeb"])
        self.assertFalse(payload["usedInternalDb"])
        self.assertIn("machine learning", llm.calls[0]["user_prompt"].lower())

    async def test_classes_today_executes_authenticated_tool(self):
        payload, calls, _, decision = await self._run("What classes do I have today?")
        self.assertEqual(decision.intent, "schedule_today")
        self.assertTrue(payload["usedInternalDb"])
        self.assertEqual([c["name"] for c in calls], ["get_today_schedule"])
        # Authenticated user id flows to the tool; the model never picks one.
        self.assertEqual(calls[0]["context"]["user_id"], "student-42")

    async def test_weakest_subject_gathers_performance_sources(self):
        payload, calls, _, decision = await self._run("What is my weakest subject?")
        self.assertEqual(decision.intent, "performance_analysis")
        names = {c["name"] for c in calls}
        self.assertTrue({"get_quiz_history", "get_progress"} <= names)
        self.assertTrue(payload["usedInternalDb"])
        self.assertTrue(payload["internalSources"])

    async def test_web_research_cites_real_sources_and_strips_fake(self):
        llm = _ScriptedLLM(text="Per the AI Index, capability rose [S1]. Bogus cite [S9].")
        payload, calls, _, decision = await self._run(
            "What are the latest developments in AI?", llm=llm
        )
        self.assertEqual(decision.intent, "web_research")
        self.assertEqual([c["name"] for c in calls], ["web_search"])
        self.assertTrue(payload["usedWeb"])
        self.assertTrue(payload["sources"])
        self.assertIn("[S1]", payload["message"])
        self.assertNotIn("[S9]", payload["message"], "invalid citations must be stripped")

    async def test_web_unavailable_says_so_instead_of_faking(self):
        registry = ToolRegistry(allowed_permissions={"READ_EXTERNAL"})
        async def failing(args):
            raise RuntimeError("Web search is not configured")
        registry.register(ToolDefinition(
            name="web_search", description="search", input_schema={"type": "object"},
            executor=failing, permission="READ_EXTERNAL", category="EXTERNAL",
        ))
        llm = _ScriptedLLM(text="should-not-be-called")
        with self.assertRaises(LLMResponseError):
            payload = await run_fast_path(
                settings=self.settings,
                llm=llm,
                registry=registry,
                decision=RouteDecision(intent="web_research", tools=("web_search",)),
                goal="latest space news",
                conversation=[],
                conversation_id="conv-local-0002",
                user_id="student-42",
                user_name="Test Student",
            )
        self.assertEqual(llm.calls, [], "LLM must not fabricate a web answer without search data")

    async def test_quiz_creation_validates_and_returns_pending_action(self):
        quiz_payload = {
            "title": "Today's Physics Quiz",
            "subject": "Physics",
            "questions": [
                {"question": "What is force?", "options": ["push or pull", "energy", "mass", "speed"], "answerIndex": 0},
                {"question": "Unit of force?", "options": ["Joule", "Newton", "Watt"], "answerIndex": 1},
            ],
        }
        llm = _ScriptedLLM(payload=quiz_payload)
        payload, calls, _, decision = await self._run("Create a quiz from today's class.", llm=llm)
        self.assertEqual(decision.intent, "action_create_quiz")
        names = [c["name"] for c in calls]
        self.assertIn("get_today_schedule", names)
        self.assertIn("save_quiz", names)
        save_call = next(c for c in calls if c["name"] == "save_quiz")
        # All generated questions passed strict validation before saving.
        self.assertEqual(len(save_call["args"]["questions"]), 2)
        # Write requires explicit user confirmation (existing EduNova flow).
        self.assertTrue(payload["actions"], "expected a pending confirmation action")
        action = payload["actions"][0]
        self.assertTrue(action["data"]["requiresConfirmation"])
        self.assertEqual(action["data"]["confirmationToken"], "token-123")
        self.assertIn("Confirm", payload["message"])
        # The JSON-mode LLM was given the quiz schema (grammar-constrained locally).
        self.assertIsNotNone(llm.calls[0]["json_schema"])

    async def test_study_plan_creation_returns_pending_action(self):
        plan_payload = {
            "title": "Physics Exam Plan",
            "subject": "Physics",
            "schedule": [
                {"day": "Day 1", "time": "17:00", "subject": "Physics", "topic": "Thermo", "task": "Review notes"},
                {"day": "Day 2", "time": "17:00", "subject": "Physics", "topic": "Optics", "task": "Practice problems"},
            ],
        }
        llm = _ScriptedLLM(payload=plan_payload)
        payload, calls, _, decision = await self._run("Create a study plan for my physics exam", llm=llm)
        self.assertEqual(decision.intent, "action_study_plan")
        self.assertTrue(any(c["name"] == "create_study_plan" for c in calls))
        self.assertTrue(payload["actions"][0]["data"]["requiresConfirmation"])

    async def test_model_loading_error_propagates_without_faking(self):
        failing = LLMResponseError(
            "The self-hosted EduNova model is still starting",
            status_code=503,
            error_type="model_loading",
        )
        llm = _ScriptedLLM(fail=failing)
        with self.assertRaises(LLMResponseError) as ctx:
            await self._run("What is machine learning?", llm=llm)
        self.assertEqual(ctx.exception.error_type, "model_loading")


class QuizPlanValidationTests(unittest.TestCase):
    def test_quiz_requires_questions(self):
        with self.assertRaises(ValueError):
            validate_quiz_payload({"title": "x", "questions": []})
        with self.assertRaises(ValueError):
            validate_quiz_payload({"questions": "not-a-list"})

    def test_quiz_rejects_incomplete_or_invalid_payload_instead_of_dropping_questions(self):
        for payload in [
            {"title": "Title", "questions": [{"question": "Q?", "options": ["a", "b"], "answerIndex": 1}]},
            {"title": "Title", "subject": "Physics", "questions": [{"question": "Q?", "options": ["a", "b"], "answerIndex": 7}]},
        ]:
            with self.assertRaises(ValueError):
                validate_quiz_payload(payload)

    def test_plan_requires_schedule(self):
        with self.assertRaises(ValueError):
            validate_plan_payload({"title": "Plan", "schedule": []})

    def test_plan_does_not_invent_missing_times_and_subjects(self):
        with self.assertRaises(ValueError):
            validate_plan_payload({"title": "P", "schedule": [{"topic": "Optics"}]})


# ---------------------------------------------------------------------------
# Fake llama_cpp module for LocalModelManager / LocalLlamaLLM unit tests.
# ---------------------------------------------------------------------------

class _FakeGrammar:
    captured: list[str] = []

    @staticmethod
    def from_json_schema(schema_str: str):
        _FakeGrammar.captured.append(schema_str)
        return {"grammar_for": schema_str[:60]}


class _FakeLlama:
    instances: list["_FakeLlama"] = []

    def __init__(self, **kwargs):
        self.kwargs = kwargs
        self.calls: list[dict] = []
        _FakeLlama.instances.append(self)

    def create_completion(self, prompt=None, max_tokens=None, grammar=None, stop=None, **kwargs):
        self.calls.append({"prompt": prompt, "max_tokens": max_tokens, "grammar": grammar, "stop": stop})
        return {
            "choices": [
                {"text": '{"action": "final", "answer": "Local answer.", "status": "done", "stateUpdate": {"confidence": "HIGH"}}'}
            ]
        }


class _FailingWarmupLlama(_FakeLlama):
    """Llama handle whose decode raises — warm-up must not report READY."""

    def create_completion(self, prompt=None, max_tokens=None, grammar=None, stop=None, **kwargs):
        raise RuntimeError("simulated decode failure")


def _install_fake_llama_cpp():
    module = types.ModuleType("llama_cpp")
    module.Llama = _FakeLlama
    module.LlamaGrammar = _FakeGrammar
    return patch.dict(sys.modules, {"llama_cpp": module, "llama_cpp.llama": module})


class WeightsEngineTests(unittest.IsolatedAsyncioTestCase):
    """LocalModelManager is now ONLY the weights engine used inside the inference worker."""

    def _settings_with_dir(self, tmp: str, **kw) -> Settings:
        kw.setdefault("local_model_dir", tmp)
        kw.setdefault("local_model_file", "fake-model.gguf")
        return local_settings(**kw)

    def _make_model_bytes(self, tmp: str, name: str = "fake-model.gguf") -> Path:
        path = Path(tmp) / name
        path.write_bytes(b"GGUF" + b"\x00" * (11 * 1024 * 1024))
        return path

    async def test_load_then_generate_uses_chatml_and_grammar(self):
        with tempfile.TemporaryDirectory() as tmp:
            settings = self._settings_with_dir(tmp)
            self._make_model_bytes(tmp)
            manager = LocalModelManager(settings)
            _FakeGrammar.captured.clear()
            with _install_fake_llama_cpp():
                await manager._load_model()
                self.assertTrue(manager.is_loaded())
                text = await manager.generate(system_prompt="sys", user_prompt="What is ML?", max_tokens=64, json_schema=DECISION_SCHEMA)
            self.assertIn('"action"', text)
            llama = _FakeLlama.instances[-1]
            self.assertEqual(llama.kwargs["n_ctx"], settings.local_model_ctx_size)
            self.assertEqual(llama.kwargs["n_gpu_layers"], 0)
            call = llama.calls[-1]
            self.assertIn("<|im_start|>", call["prompt"])
            self.assertIn("What is ML?", call["prompt"])
            self.assertIsNotNone(call["grammar"], "decision schema must force valid JSON")
            snap = manager.snapshot()
            self.assertTrue(snap["modelLoaded"])
            self.assertEqual(snap["chatFormat"], "chatml")

    async def test_generate_never_fakes_when_weights_not_loaded(self):
        settings = local_settings()
        manager = LocalModelManager(settings)
        with self.assertRaises(LLMResponseError) as ctx:
            await manager.generate(system_prompt="s", user_prompt="hello", max_tokens=8)
        self.assertEqual(ctx.exception.error_type, "MODEL_NOT_READY")
        self.assertEqual(ctx.exception.status_code, 503)

    async def test_decode_failure_surfaces_instead_of_partial_answer(self):
        with tempfile.TemporaryDirectory() as tmp:
            settings = self._settings_with_dir(tmp)
            self._make_model_bytes(tmp)
            manager = LocalModelManager(settings)
            fake = types.SimpleNamespace(Llama=_FailingWarmupLlama, LlamaGrammar=_FakeGrammar)
            with patch.dict(sys.modules, {"llama_cpp": fake, "llama_cpp.llama": fake}):
                await manager._load_model()
                with self.assertRaises(LLMResponseError):
                    await manager.generate(system_prompt="s", user_prompt="hi", max_tokens=8)

    async def test_min_size_guard_rejects_tiny_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            settings = self._settings_with_dir(tmp)
            tiny = Path(tmp) / "fake-model.gguf"
            tiny.write_bytes(b"not a real model")
            manager = LocalModelManager(settings)
            self.assertFalse(tiny.stat().st_size >= 11 * 1024 * 1024)
            self.assertEqual(str(manager.model_path), str(tiny))

    async def test_filename_sanitization(self):
        with tempfile.TemporaryDirectory() as tmp:
            settings = self._settings_with_dir(tmp, local_model_file='../../etc/evil";rm -rf.gguf')
            manager = LocalModelManager(settings)
            self.assertTrue(manager.model_path.name.endswith(".gguf"))
            self.assertNotIn("/", manager.model_path.name)
            self.assertNotIn("..", manager.model_path.name)


class ResourceCheckTests(unittest.TestCase):
    """Pre-load memory compatibility check: fail fast, precise numbers, no silent shrink."""

    def test_512mib_container_is_rejected_with_numbers(self):
        requirement = estimate_requirement(runtime="llama_cpp", model_path=None, ctx=6144, expected_bytes=397 * 1024 * 1024)
        self.assertGreater(requirement["required_mb"], 512)
        with self.assertRaises(ResourceInsufficient) as ctx:
            check_model_fits(requirement, {"ram_limit_mb": 512, "ram_total_mb": 512})
        report = ctx.exception.report()
        self.assertEqual(report["error"], "MODEL_RESOURCE_INSUFFICIENT")
        self.assertEqual(report["available_mb"], 512)
        self.assertEqual(report["required_mb"], requirement["required_mb"])
        self.assertGreaterEqual(report["recommended_mb"], report["required_mb"])
        self.assertIn("512 MiB", str(ctx.exception))

    def test_sufficient_container_passes(self):
        requirement = estimate_requirement(runtime="llama_cpp", model_path=None, ctx=6144, expected_bytes=397 * 1024 * 1024)
        check_model_fits(requirement, {"ram_limit_mb": 2048, "ram_total_mb": 4096})  # no exception


class RemoteInferenceClientTests(unittest.IsolatedAsyncioTestCase):
    """Orchestrator -> inference service contract, with a fake HTTP transport."""

    def _client(self, handler):
        import httpx
        settings = local_settings(inference_url="http://inference:8002", ai_internal_token="secret-token")
        transport = httpx.MockTransport(handler)
        return RemoteInferenceLLM(settings, client=httpx.AsyncClient(transport=transport))

    async def test_status_sends_internal_token_and_maps_ready(self):
        import httpx
        seen = {}

        def handler(request):
            seen["token"] = request.headers.get("X-AI-Internal-Token")
            seen["path"] = request.url.path
            return httpx.Response(200, json={"state": "MODEL_READY", "model_loaded": True, "warmup_complete": True, "inference_test": True})

        llm = self._client(handler)
        status = await llm.status()
        self.assertEqual(seen["token"], "secret-token")
        self.assertEqual(seen["path"], "/model/status")
        self.assertEqual(status["state"], "MODEL_READY")
        await llm.probe()  # READY -> no exception

    async def test_resource_insufficient_is_reported_verbatim(self):
        import httpx

        def handler(request):
            return httpx.Response(200, json={"state": "MODEL_FAILED", "errorStage": "MODEL_RESOURCE_INSUFFICIENT",
                                             "error": "needs 1100 MiB", "permanentFailure": True,
                                             "resource": {"required_mb": 1100, "available_mb": 512, "recommended_mb": 2048}})

        llm = self._client(handler)
        with self.assertRaises(LLMResponseError) as ctx:
            await llm.probe()
        self.assertEqual(ctx.exception.error_type, "MODEL_RESOURCE_INSUFFICIENT")
        self.assertEqual(ctx.exception.status_code, 503)

    async def test_loading_state_is_not_ready_and_not_generic(self):
        import httpx

        def handler(request):
            return httpx.Response(200, json={"state": "MODEL_LOADING", "model_loaded": False})

        llm = self._client(handler)
        with self.assertRaises(LLMResponseError) as ctx:
            await llm.probe()
        self.assertEqual(ctx.exception.error_type, "MODEL_LOADING")
        self.assertIn("starting", str(ctx.exception))

    async def test_unreachable_service_maps_to_ai_service_unreachable(self):
        import httpx

        def handler(request):
            raise httpx.ConnectError("refused")

        llm = self._client(handler)
        with self.assertRaises(LLMResponseError) as ctx:
            await llm.status()
        self.assertEqual(ctx.exception.error_type, "AI_SERVICE_UNREACHABLE")

    async def test_missing_url_is_configuration_error(self):
        from agent.llm import LLMConfigurationError
        llm = RemoteInferenceLLM(local_settings(inference_url=""))
        with self.assertRaises(LLMConfigurationError):
            await llm.status()

    async def test_streaming_completion_forwards_tokens_and_full_text(self):
        import httpx

        def handler(request):
            if request.url.path == "/generate/stream":
                body = ("data: " + json.dumps({"type": "token", "delta": "Hel"}) + "\n\n"
                        "data: " + json.dumps({"type": "token", "delta": "lo"}) + "\n\n"
                        "data: " + json.dumps({"type": "done", "text": "Hello", "metrics": {"tokens": 2, "finishReason": "stop"}}) + "\n\n")
                return httpx.Response(200, content=body.encode(), headers={"content-type": "text/event-stream"})
            return httpx.Response(404)

        llm = self._client(handler)
        pieces = []
        text = await llm.complete_text(system_prompt="s", user_prompt="u", on_token=pieces.append)
        self.assertEqual(text, "Hello")
        self.assertEqual(pieces, ["Hel", "lo"])
        self.assertEqual(llm.last_generation_metrics["finishReason"], "stop")

    async def test_json_completion_parses_object(self):
        import httpx

        def handler(request):
            payload = json.loads(request.content)
            self.assertIsNotNone(payload.get("json_schema"))
            return httpx.Response(200, json={"text": '{"action": "final", "answer": "ok"}', "metrics": {"tokens": 5}})

        llm = self._client(handler)
        result = await llm.complete_json(system_prompt="s", user_prompt="u")
        self.assertEqual(result["action"], "final")

    async def test_inference_error_propagates_code(self):
        import httpx

        def handler(request):
            return httpx.Response(503, json={"detail": {"code": "MODEL_BUSY", "message": "busy"}})

        llm = self._client(handler)
        with self.assertRaises(LLMResponseError) as ctx:
            await llm.complete_json(system_prompt="s", user_prompt="u", retries=0)
        self.assertEqual(ctx.exception.error_type, "MODEL_BUSY")


class CompactPlannerTests(unittest.IsolatedAsyncioTestCase):
    async def test_compact_mode_shrinks_system_prompt(self):
        from agent.engine import AgentEngine

        registry = ToolRegistry(allowed_permissions={"UTILITY"})
        from agent.tools import build_utility_tools

        for defn in build_utility_tools():
            registry.register(defn)

        class CaptureLLM:
            is_local = True

            def __init__(self):
                self.system_prompts: list[str] = []

            async def complete_json(self, *, system_prompt, user_prompt, **kwargs):
                self.system_prompts.append(system_prompt)
                return {"action": "final", "answer": "42", "stateUpdate": {"confidence": "HIGH"}}

        llm = CaptureLLM()
        engine = AgentEngine(local_settings(), llm, registry)
        result = await engine.run(
            goal="what is 21*2", conversation=[], conversation_id="conv-compact-1"
        )
        self.assertTrue(result.success)
        prompt = llm.system_prompts[0]
        self.assertIn("Tools:", prompt)
        self.assertIn("calculator", prompt)
        self.assertNotIn("UNIFIED DATA-AWARE autonomous", prompt, "local model gets the compact prompt")
        self.assertLess(len(prompt), 4000)


if __name__ == "__main__":
    unittest.main()

class IntegratedIntentTests(unittest.IsolatedAsyncioTestCase):
    async def test_ar_quiz_is_an_action_not_a_generic_ar_navigation_request(self):
        decision = IntentRouter(local_settings()).classify("Create a practice quiz from this AR lesson's learning objectives.", [])
        self.assertEqual(decision.intent, "action_create_quiz")

    async def test_ar_discovery_uses_published_ids_and_application_navigation(self):
        registry = ToolRegistry(allowed_permissions={"READ_INTERNAL"})
        calls = []
        async def lessons(args, context=None):
            self.assertEqual(args, {"topic": "Human Eye"})
            return {"lessons": [{"_id": "64d000000000000000000001", "title": "Human Eye", "topic": "Human Eye"}]}
        async def navigate(args, context=None):
            calls.append(args)
            return {"navigate": args, "message": "Open lesson"}
        for name, executor in [("get_ar_lessons", lessons), ("open_feature", navigate)]:
            registry.register(ToolDefinition(name=name, description=name, input_schema={"type": "object"}, executor=executor, permission="READ_INTERNAL", category="INTERNAL"))
        settings = local_settings()
        result = await run_fast_path(settings=settings, llm=_ScriptedLLM(text="Explore the published eye lesson."), registry=registry,
            decision=IntentRouter(settings).classify("Explain Human Eye in AR", []), goal="Explain Human Eye in AR", conversation=[], conversation_id="ar-contract", user_id="student-42", user_name="Student")
        self.assertEqual(calls, [{"view": "ar", "id": "64d000000000000000000001"}])
        self.assertEqual(result["actions"][0]["data"]["navigate"], calls[0])

    async def test_no_recorded_class_cannot_become_a_successful_today_quiz(self):
        registry = ToolRegistry(allowed_permissions={"READ_INTERNAL"})
        async def empty(args, context=None): return {"periods": [], "liveSessions": []}
        registry.register(ToolDefinition(name="get_today_schedule", description="schedule", input_schema={"type": "object"}, executor=empty, permission="READ_INTERNAL", category="INTERNAL"))
        settings = local_settings(); llm = _ScriptedLLM(text="must not run")
        with self.assertRaises(LLMResponseError) as failure:
            await run_fast_path(settings=settings, llm=llm, registry=registry, decision=IntentRouter(settings).classify("Create a quiz from today's class", []),
                goal="Create a quiz from today's class", conversation=[], conversation_id="no-class", user_id="student-42", user_name="Student")
        self.assertEqual(failure.exception.error_type, "CLASS_CONTEXT_NOT_FOUND")
        self.assertEqual(llm.calls, [])
