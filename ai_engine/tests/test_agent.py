from __future__ import annotations

import sys
from dataclasses import replace
from pathlib import Path
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from agent.engine import AgentEngine
from agent.llm import parse_json_object
from agent.tools import build_web_tools
from agent.tools.base import ToolDefinition, ToolRegistry
from agent.tools.web import FetchedPage, ToolInputError, ToolSecurityError, WebTools, validate_public_url
from config import load_settings


class ScriptedLLM:
    def __init__(self, decisions):
        self.decisions = list(decisions)
        self.calls = 0

    async def complete_json(self, **kwargs):
        self.calls += 1
        if self.decisions:
            return self.decisions.pop(0)
        return {
            "action": "final",
            "answer": "I reached the safety boundary and used the available evidence.",
            "stateUpdate": {"confidence": "LOW"},
        }


def final(answer):
    return {
        "action": "final",
        "answer": answer,
        "stateUpdate": {
            "goalType": "learning",
            "currentUnderstanding": "The goal is ready to answer.",
            "confidence": "HIGH",
        },
    }


def tool(name, arguments):
    return {
        "action": "tool",
        "toolName": name,
        "toolInput": arguments,
        "answer": "",
        "stateUpdate": {
            "goalType": "research",
            "currentUnderstanding": "More current evidence is useful.",
            "unknowns": ["Current authoritative detail"],
            "confidence": "LOW",
        },
    }


def settings(**overrides):
    return replace(
        load_settings(),
        max_agent_iterations=overrides.get("max_agent_iterations", 8),
        max_tool_calls=overrides.get("max_tool_calls", 8),
    )


class AgentEngineTests(unittest.IsolatedAsyncioTestCase):
    async def test_stable_question_finishes_without_tools(self):
        calls = 0

        async def should_not_run(arguments):
            nonlocal calls
            calls += 1
            return {}

        registry = ToolRegistry()
        registry.register(
            ToolDefinition(
                name="web_search",
                description="search",
                input_schema={},
                executor=should_not_run,
                permission="READ_EXTERNAL",
                timeout_seconds=1,
                result_format="results",
            )
        )
        engine = AgentEngine(
            settings(),
            ScriptedLLM([final("Inheritance lets a class reuse and extend another class.")]),
            registry,
        )
        result = await engine.run(
            goal="What is inheritance?", conversation=[], conversation_id="conversation123456"
        )
        self.assertTrue(result.success)
        self.assertFalse(result.used_web)
        self.assertEqual(calls, 0)
        self.assertEqual(result.sources, [])

    async def test_agent_controls_multi_step_research(self):
        executed = []

        async def search(arguments):
            executed.append(("web_search", arguments))
            return {
                "query": arguments["query"],
                "results": [
                    {
                        "title": "Node.js Releases",
                        "url": "https://nodejs.org/en/about/previous-releases",
                        "snippet": "Official release information",
                        "publishedDate": None,
                    }
                ],
            }

        async def open_page(arguments):
            executed.append(("open_url", arguments))
            return {
                "url": arguments["url"],
                "title": "Node.js Releases",
                "excerpt": "Current release details",
            }

        registry = ToolRegistry()
        for name, executor in (("web_search", search), ("open_url", open_page)):
            registry.register(
                ToolDefinition(
                    name=name,
                    description=name,
                    input_schema={},
                    executor=executor,
                    permission="READ_EXTERNAL",
                    timeout_seconds=1,
                    result_format="object",
                )
            )
        llm = ScriptedLLM(
            [
                tool("web_search", {"query": "latest Node.js release official", "max_results": 3}),
                tool("open_url", {"url": "https://nodejs.org/en/about/previous-releases"}),
                final("The official release page reports the current release details [S1]."),
            ]
        )
        result = await AgentEngine(settings(), llm, registry).run(
            goal="What is the latest Node.js version?",
            conversation=[],
            conversation_id="conversation123456",
        )
        self.assertEqual([item[0] for item in executed], ["web_search", "open_url"])
        self.assertTrue(result.used_web)
        self.assertEqual(result.sources[0]["id"], "S1")
        self.assertEqual(result.sources[0]["url"], "https://nodejs.org/en/about/previous-releases")

    async def test_tool_failure_becomes_observation_and_agent_can_refine(self):
        attempts = []

        async def sometimes_fails(arguments):
            attempts.append(arguments["query"])
            if len(attempts) == 1:
                raise RuntimeError("provider unavailable")
            return {
                "results": [
                    {
                        "title": "Official Docs",
                        "url": "https://example.com/docs",
                        "snippet": "Verified detail",
                    }
                ]
            }

        registry = ToolRegistry()
        registry.register(
            ToolDefinition(
                name="web_search",
                description="search",
                input_schema={},
                executor=sometimes_fails,
                permission="READ_EXTERNAL",
                timeout_seconds=1,
                result_format="results",
            )
        )
        llm = ScriptedLLM(
            [
                tool("web_search", {"query": "broad query"}),
                tool("web_search", {"query": "refined official query"}),
                final("The refined source supplied the needed detail [S1]."),
            ]
        )
        result = await AgentEngine(settings(), llm, registry).run(
            goal="Research a changing detail",
            conversation=[],
            conversation_id="conversation123456",
        )
        self.assertEqual(attempts, ["broad query", "refined official query"])
        self.assertTrue(result.success)
        self.assertEqual(len(result.sources), 1)

    async def test_iteration_limit_forces_bounded_final_response(self):
        async def search(arguments):
            return {"results": []}

        registry = ToolRegistry()
        registry.register(
            ToolDefinition(
                name="web_search",
                description="search",
                input_schema={},
                executor=search,
                permission="READ_EXTERNAL",
                timeout_seconds=1,
                result_format="results",
            )
        )
        llm = ScriptedLLM(
            [
                tool("web_search", {"query": "one bounded action"}),
                final("I reached the iteration boundary and am answering with the available evidence."),
            ]
        )
        result = await AgentEngine(settings(max_agent_iterations=1), llm, registry).run(
            goal="An intentionally bounded request",
            conversation=[],
            conversation_id="conversation123456",
        )
        self.assertTrue(result.limit_reached)
        self.assertIn("iteration boundary", result.message)

    async def test_tool_call_budget_stops_additional_execution(self):
        executions = 0

        async def search(arguments):
            nonlocal executions
            executions += 1
            return {"results": []}

        registry = ToolRegistry()
        registry.register(
            ToolDefinition(
                name="web_search",
                description="search",
                input_schema={},
                executor=search,
                permission="READ_EXTERNAL",
                timeout_seconds=1,
                result_format="results",
            )
        )
        llm = ScriptedLLM(
            [
                tool("web_search", {"query": "first"}),
                tool("web_search", {"query": "second"}),
                final("The tool budget is exhausted, so this answer states the limitation."),
            ]
        )
        result = await AgentEngine(settings(max_tool_calls=1), llm, registry).run(
            goal="Research this deeply",
            conversation=[],
            conversation_id="conversation123456",
        )
        self.assertEqual(executions, 1)
        self.assertTrue(result.limit_reached)

    async def test_permission_model_blocks_unapproved_tool(self):
        ran = False

        async def destructive(arguments):
            nonlocal ran
            ran = True
            return {}

        registry = ToolRegistry(allowed_permissions={"READ_EXTERNAL"})
        registry.register(
            ToolDefinition(
                name="future_write_tool",
                description="not auto-approved",
                input_schema={},
                executor=destructive,
                permission="WRITE_EXTERNAL",
                timeout_seconds=1,
                result_format="object",
            )
        )
        observation, _ = await registry.execute("future_write_tool", {})
        self.assertFalse(observation.success)
        self.assertEqual(observation.error_code, "PERMISSION_DENIED")
        self.assertFalse(ran)


class SecurityTests(unittest.IsolatedAsyncioTestCase):
    async def test_ssrf_blocks_local_and_private_addresses(self):
        blocked = [
            "http://localhost:3000",
            "http://127.0.0.1",
            "http://0.0.0.0",
            "http://169.254.169.254/latest/meta-data",
            "http://10.0.0.5",
            "http://[::1]/",
            "file:///etc/passwd",
            "gopher://example.com/",
        ]
        for url in blocked:
            with self.subTest(url=url):
                with self.assertRaises(ToolSecurityError):
                    await validate_public_url(url)

    def test_extractor_removes_scripts_and_navigation(self):
        page = FetchedPage(
            final_url="https://example.com/lesson",
            status_code=200,
            content_type="text/html",
            body=(
                b"<html><head><title>Lesson</title><script>steal()</script></head>"
                b"<body><nav>Unrelated menu</nav><main><h1>Trees</h1>"
                b"<p>A tree is a hierarchical data structure.</p></main>"
                b"<footer>Tracking links</footer></body></html>"
            ),
        )
        parsed = WebTools._parse_page(page)
        self.assertEqual(parsed["title"], "Lesson")
        self.assertIn("hierarchical data structure", parsed["text"])
        self.assertNotIn("steal", parsed["text"])
        self.assertNotIn("Unrelated menu", parsed["text"])
        self.assertNotIn("Tracking links", parsed["text"])

    def test_json_decision_parser_rejects_non_json(self):
        self.assertEqual(parse_json_object('```json\n{"action":"final"}\n```')["action"], "final")
        with self.assertRaises(Exception):
            parse_json_object("Here is my private reasoning without a decision")


class OptionalSearchTests(unittest.IsolatedAsyncioTestCase):
    """Stable questions must never depend on web-search credentials."""

    async def test_unconfigured_search_is_a_clean_tool_failure_not_a_crash(self):
        settings = self._settings_without_search()
        tools = WebTools(settings)

        with self.assertRaises(ToolInputError) as ctx:
            await tools.web_search({"query": "what is ml"})
        self.assertIn("not configured", str(ctx.exception))

        # Through the registry the same failure becomes an observation, so the
        # agent loop continues and can answer from its own knowledge instead of
        # failing the whole request.
        registry = ToolRegistry()
        for definition in build_web_tools(settings):
            registry.register(definition)
        observation, record = await registry.execute("web_search", {"query": "what is ml"})
        self.assertFalse(observation.success)
        self.assertEqual(record.error_code, "INVALID_TOOL_INPUT")
        self.assertIn("not configured", observation.observation["error"])

    @staticmethod
    def _settings_without_search():
        import os

        from config import Settings

        return Settings(
            llm_api_key=os.getenv("LLM_API_KEY", "test-key"),
            llm_model="test-model",
            llm_base_url="https://llm.example.invalid/v1",
            llm_timeout_seconds=5,
            llm_max_output_tokens=256,
            llm_temperature=0.2,
            llm_json_mode=True,
            web_search_api_key="",
            web_search_provider="",
            web_search_max_results=5,
            web_request_timeout_seconds=5,
            web_max_content_length=100_000,
            web_max_extracted_chars=20_000,
            web_max_redirects=3,
            max_agent_iterations=4,
            max_tool_calls=4,
            max_agent_runtime_seconds=30,
            agent_max_context_chars=20_000,
            conversation_max_turns=4,
            conversation_ttl_seconds=3_600,
            ai_internal_token="",
            ai_require_internal_token=False,
            cors_origins=("http://localhost:5173",),
        )


if __name__ == "__main__":
    unittest.main()
