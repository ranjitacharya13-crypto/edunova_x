"""Regression tests for LLM provider failure classification.

Covers the complete LLM request path for EduNova AI.

Run: python -m pytest ai_engine/tests/test_llm_provider.py -v
or:   python -m unittest ai_engine/tests/test_llm_provider.py
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import httpx
from agent.llm import LLMConfigurationError, LLMResponseError, OpenAICompatibleLLM, parse_json_object, _build_chat_completions_url, _sanitize_provider_message
from agent.engine import AgentEngine
from agent.tools.base import ToolDefinition, ToolRegistry
from config import load_settings, Settings, _clean_env_value, _normalize_base_url


class ConfigAliasTests(unittest.TestCase):
    def test_only_canonical_llm_api_key_is_accepted(self):
        previous = {name: os.getenv(name) for name in ("LLM_API_KEY", "OPENAI_API_KEY", "LLM_PROVIDER")}
        try:
            os.environ.pop("LLM_API_KEY", None)
            os.environ["OPENAI_API_KEY"] = "must-not-be-used"
            os.environ["LLM_PROVIDER"] = "openai"
            settings = load_settings()
            self.assertEqual(settings.llm_api_key, "")
            self.assertFalse(settings.llm_configured)
            os.environ["LLM_API_KEY"] = "canonical-key"
            self.assertEqual(load_settings().llm_api_key, "canonical-key")
        finally:
            for name, value in previous.items():
                if value is None: os.environ.pop(name, None)
                else: os.environ[name] = value

    def test_quoted_api_key_stripped(self):
        prev = os.getenv("LLM_API_KEY")
        try:
            os.environ["LLM_API_KEY"] = '"sk-quoted-key"'
            os.environ["LLM_MODEL"] = "test-model"
            os.environ["LLM_BASE_URL"] = "https://api.openai.com/v1"
            settings = load_settings()
            self.assertEqual(settings.llm_api_key, "sk-quoted-key")
            # Also test single quotes
            os.environ["LLM_API_KEY"] = "'sk-single-quoted'"
            settings = load_settings()
            self.assertEqual(settings.llm_api_key, "sk-single-quoted")
            # Test surrounding whitespace + quotes
            os.environ["LLM_API_KEY"] = '  "  sk-spaced  "  '
            settings = load_settings()
            # Inner value after stripping surrounding quotes and then outer strip
            self.assertEqual(settings.llm_api_key, "sk-spaced")
        finally:
            if prev is not None:
                os.environ["LLM_API_KEY"] = prev
            elif "LLM_API_KEY" in os.environ:
                del os.environ["LLM_API_KEY"]

    def test_quoted_base_url_stripped(self):
        prev = os.getenv("LLM_BASE_URL")
        try:
            os.environ["LLM_BASE_URL"] = '"https://api.openai.com/v1/"'
            settings = load_settings()
            self.assertEqual(settings.llm_base_url, "https://api.openai.com/v1")
            os.environ["LLM_BASE_URL"] = "'https://api.openai.com/v1'"
            settings = load_settings()
            self.assertEqual(settings.llm_base_url, "https://api.openai.com/v1")
            os.environ["LLM_BASE_URL"] = '  " https://api.openai.com/v1/ "  '
            settings = load_settings()
            self.assertEqual(settings.llm_base_url, "https://api.openai.com/v1")
        finally:
            if prev is not None:
                os.environ["LLM_BASE_URL"] = prev
            elif "LLM_BASE_URL" in os.environ:
                del os.environ["LLM_BASE_URL"]

    def test_openai_provider_rejects_mismatched_base_url(self):
        settings = Settings(llm_provider="openai", llm_api_key="present", llm_model="gpt-4.1-mini", llm_base_url="https://generativelanguage.googleapis.com/v1")
        self.assertFalse(settings.llm_configured)
        self.assertEqual(settings.llm_configuration_error, "provider_base_url_mismatch")

    def test_safe_diagnostics_expose_names_not_secrets(self):
        settings = Settings(llm_provider="openai", llm_api_key="super-secret", llm_model="gpt-4.1-mini", llm_base_url="https://api.openai.com/v1")
        diagnostics = settings.llm_safe_diagnostics()
        self.assertEqual(diagnostics["provider"], "openai")
        self.assertEqual(diagnostics["model"], "gpt-4.1-mini")
        self.assertTrue(diagnostics["apiKeyPresent"])
        self.assertNotIn("super-secret", json.dumps(diagnostics))

    def test_llm_configuration_invalid_safe_diagnostics(self):
        prev_key = os.getenv("LLM_API_KEY")
        prev_model = os.getenv("LLM_MODEL")
        prev_base = os.getenv("LLM_BASE_URL")
        try:
            if "LLM_API_KEY" in os.environ:
                del os.environ["LLM_API_KEY"]
            if "OPENAI_API_KEY" in os.environ:
                del os.environ["OPENAI_API_KEY"]
            os.environ["LLM_MODEL"] = "gpt-4.1-mini"
            os.environ["LLM_BASE_URL"] = "https://api.openai.com/v1"
            settings = load_settings()
            self.assertFalse(settings.llm_configured)
            diag = settings.llm_safe_diagnostics()
            self.assertFalse(diag["llm_configured"])
            self.assertFalse(diag["llm_api_key_present"])
            self.assertTrue(diag["llm_model_present"])
            # Ensure diagnostics never contain the actual key
            diag_str = json.dumps(diag)
            self.assertNotIn("sk-", diag_str)
        finally:
            for k, v in [("LLM_API_KEY", prev_key), ("LLM_MODEL", prev_model), ("LLM_BASE_URL", prev_base)]:
                if v is not None:
                    os.environ[k] = v
                elif k in os.environ:
                    del os.environ[k]


class BaseUrlNormalizationTests(unittest.TestCase):
    def test_trailing_slash_stripped(self):
        self.assertEqual(_normalize_base_url("https://api.openai.com/v1/"), "https://api.openai.com/v1")
        self.assertEqual(_normalize_base_url("https://api.openai.com/v1//"), "https://api.openai.com/v1")

    def test_chat_completions_duplicate_removed(self):
        self.assertEqual(
            _normalize_base_url("https://api.openai.com/v1/chat/completions"),
            "https://api.openai.com/v1",
        )
        self.assertEqual(
            _normalize_base_url("https://api.openai.com/v1/chat/completions/"),
            "https://api.openai.com/v1",
        )
        self.assertEqual(
            _normalize_base_url("https://api.groq.com/openai/v1/chat/completions"),
            "https://api.groq.com/openai/v1",
        )

    def test_double_v1_collapsed(self):
        self.assertEqual(
            _normalize_base_url("https://api.openai.com/v1/v1"), "https://api.openai.com/v1"
        )
        self.assertEqual(
            _normalize_base_url("https://api.openai.com/v1/v1/"), "https://api.openai.com/v1"
        )

    def test_missing_scheme_prefixed(self):
        self.assertEqual(_normalize_base_url("api.openai.com/v1"), "https://api.openai.com/v1")

    def test_whitespace_stripped(self):
        self.assertEqual(_normalize_base_url(" https://api.openai.com/v1 "), "https://api.openai.com/v1")
        self.assertEqual(_normalize_base_url("https://api.openai.com/v1 \n"), "https://api.openai.com/v1")

    def test_empty_defaults_to_openai(self):
        self.assertEqual(_normalize_base_url(""), "https://api.openai.com/v1")
        self.assertEqual(_normalize_base_url("   "), "https://api.openai.com/v1")

    def test_build_chat_url_no_duplication(self):
        self.assertEqual(
            _build_chat_completions_url("https://api.openai.com/v1"),
            "https://api.openai.com/v1/chat/completions",
        )
        self.assertEqual(
            _build_chat_completions_url("https://api.openai.com/v1/"),
            "https://api.openai.com/v1/chat/completions",
        )
        self.assertEqual(
            _build_chat_completions_url("https://api.openai.com/v1/chat/completions"),
            "https://api.openai.com/v1/chat/completions",
        )
        self.assertEqual(
            _build_chat_completions_url("https://api.openai.com/v1/chat/completions/"),
            "https://api.openai.com/v1/chat/completions",
        )
        # Already has double v1
        self.assertEqual(
            _build_chat_completions_url("https://api.openai.com/v1/v1"),
            "https://api.openai.com/v1/chat/completions",
        )


class LLMClientErrorClassificationTests(unittest.IsolatedAsyncioTestCase):
    def _settings(self, api_key="test-key", model="test-model", base_url="https://llm.example.invalid/v1"):
        return Settings(
            llm_provider="openai_compatible",
            llm_api_key=api_key,
            llm_model=model,
            llm_base_url=_normalize_base_url(base_url),
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
            conversation_ttl_seconds=3600,
            ai_internal_token="",
            ai_require_internal_token=False,
            cors_origins=("http://localhost:5173",),
        )

    async def test_missing_api_key_raises_configuration(self):
        settings = self._settings(api_key="")
        llm = OpenAICompatibleLLM(settings)
        with self.assertRaises(LLMConfigurationError) as ctx:
            await llm.complete_json(system_prompt="sys", user_prompt="what is ml")
        self.assertIn("not configured", str(ctx.exception).lower())

    async def test_invalid_api_key_401_classified(self):
        settings = self._settings()
        # Mock httpx to return 401
        mock_response = MagicMock(spec=httpx.Response)
        mock_response.status_code = 401
        mock_response.json.return_value = {"error": {"message": "Incorrect API key provided", "type": "invalid_request_error"}}
        mock_response.text = '{"error": {"message": "Incorrect API key provided"}}'

        async def mock_post(*args, **kwargs):
            # Simulate the httpx raise behavior: _request will call response.raise logic via our code path
            # Instead we mock client.post to return a response with 401 status and let _request handle it
            return mock_response

        mock_client = MagicMock(spec=httpx.AsyncClient)
        mock_client.post = AsyncMock(side_effect=mock_post)
        # Need to bypass __aenter__ etc? OpenAICompatibleLLM uses direct post on injected client
        # Patch _build_chat_completions_url to avoid network
        llm = OpenAICompatibleLLM(settings, client=mock_client)
        # Simulate http status handling: our _request will see 401 and raise LLMResponseError directly without going through raise_for_status
        # So we need to make mock response behave like httpx response with status >=400 and json
        # Our implementation checks status_code >=400 inside _request and raises LLMResponseError
        with self.assertRaises(LLMResponseError) as ctx:
            await llm.complete_json(system_prompt="sys", user_prompt="what is ml")
        exc = ctx.exception
        self.assertEqual(exc.status_code, 401)
        self.assertIn("authentication", exc.error_type)
        # Ensure provider message is sanitized and does not contain raw key
        self.assertNotIn("test-key", str(exc.provider_message))

    async def test_invalid_model_404_classified(self):
        settings = self._settings()
        mock_response = MagicMock(spec=httpx.Response)
        mock_response.status_code = 404
        mock_response.json.return_value = {"error": {"message": "The model `bad-model` does not exist", "type": "invalid_request_error", "code": "model_not_found"}}
        mock_response.text = '{"error": {"message": "The model `bad-model` does not exist"}}'

        mock_client = MagicMock(spec=httpx.AsyncClient)
        mock_client.post = AsyncMock(return_value=mock_response)

        llm = OpenAICompatibleLLM(settings, client=mock_client)
        with self.assertRaises(LLMResponseError) as ctx:
            await llm.complete_json(system_prompt="sys", user_prompt="what is ml")
        exc = ctx.exception
        self.assertEqual(exc.status_code, 404)
        self.assertIn("not_found", exc.error_type.lower())

    async def test_rate_limit_429_classified(self):
        settings = self._settings()
        mock_response = MagicMock(spec=httpx.Response)
        mock_response.status_code = 429
        mock_response.json.return_value = {"error": {"message": "Rate limit reached", "type": "rate_limit_error"}}
        mock_response.text = 'Rate limit'

        mock_client = MagicMock(spec=httpx.AsyncClient)
        mock_client.post = AsyncMock(return_value=mock_response)

        llm = OpenAICompatibleLLM(settings, client=mock_client)
        with self.assertRaises(LLMResponseError) as ctx:
            await llm.complete_json(system_prompt="sys", user_prompt="what is ml")
        self.assertEqual(ctx.exception.status_code, 429)
        self.assertEqual(ctx.exception.error_type, "rate_limit")

    async def test_timeout_classified(self):
        settings = self._settings()
        mock_client = MagicMock(spec=httpx.AsyncClient)
        mock_client.post = AsyncMock(side_effect=httpx.TimeoutException("timeout"))

        llm = OpenAICompatibleLLM(settings, client=mock_client)
        with self.assertRaises(LLMResponseError) as ctx:
            await llm.complete_json(system_prompt="sys", user_prompt="what is ml")
        # Should be 504 timeout
        self.assertIn(ctx.exception.status_code, (504, 408, 503))
        self.assertIn("timeout", ctx.exception.error_type.lower())

    async def test_network_error_classified(self):
        settings = self._settings()
        mock_client = MagicMock(spec=httpx.AsyncClient)
        mock_client.post = AsyncMock(side_effect=httpx.ConnectError("DNS failure"))

        llm = OpenAICompatibleLLM(settings, client=mock_client)
        with self.assertRaises(LLMResponseError) as ctx:
            await llm.complete_json(system_prompt="sys", user_prompt="what is ml")
        self.assertEqual(ctx.exception.status_code, 503)
        combined = (ctx.exception.error_type.lower() + " " + ctx.exception.provider_message.lower())
        self.assertTrue("network" in combined or "dns" in combined, combined)

    async def test_response_format_retry(self):
        """If provider returns 400 for response_format, client retries without it and succeeds."""
        settings = self._settings()
        # First call returns 400 mentioning response_format, second succeeds
        call_count = 0

        async def side_effect(*args, **kwargs):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                resp = MagicMock(spec=httpx.Response)
                resp.status_code = 400
                resp.json.return_value = {"error": {"message": "Unknown parameter: 'response_format'", "type": "invalid_request_error"}}
                resp.text = "response_format unsupported"
                return resp
            else:
                # Success response
                resp = MagicMock(spec=httpx.Response)
                resp.status_code = 200
                resp.json.return_value = {
                    "choices": [{"message": {"content": '{"action": "final", "answer": "Machine learning is ...", "stateUpdate": {}}'}}]
                }
                return resp

        mock_client = MagicMock(spec=httpx.AsyncClient)
        mock_client.post = AsyncMock(side_effect=side_effect)

        llm = OpenAICompatibleLLM(settings, client=mock_client)
        result = await llm.complete_json(system_prompt="sys", user_prompt="what is ml")
        self.assertEqual(result["action"], "final")
        self.assertEqual(call_count, 2)
        # Verify payload second call did not contain response_format - we check via mock calls
        second_call = mock_client.post.call_args_list[1]
        payload = second_call.kwargs.get("json") or second_call.args[1] if len(second_call.args) > 1 else {}
        # The JSON payload is kwarg json
        json_payload = second_call.kwargs.get("json") or {}
        self.assertNotIn("response_format", json_payload)

    async def test_max_tokens_swap_retry(self):
        """If provider says max_tokens unsupported, swap to max_completion_tokens."""
        settings = self._settings()
        call_count = 0

        async def side_effect(*args, **kwargs):
            nonlocal call_count
            call_count += 1
            payload = kwargs.get("json", {})
            if call_count == 1:
                # Must contain max_tokens
                assert "max_tokens" in payload
                resp = MagicMock(spec=httpx.Response)
                resp.status_code = 400
                resp.json.return_value = {"error": {"message": "Unsupported parameter: 'max_tokens' - use 'max_completion_tokens' instead", "type": "invalid_request_error"}}
                resp.text = "max_tokens unsupported"
                return resp
            else:
                assert "max_completion_tokens" in payload
                assert "max_tokens" not in payload
                resp = MagicMock(spec=httpx.Response)
                resp.status_code = 200
                resp.json.return_value = {
                    "choices": [{"message": {"content": '{"action":"final","answer":"ok"}'}}]
                }
                return resp

        mock_client = MagicMock(spec=httpx.AsyncClient)
        mock_client.post = AsyncMock(side_effect=side_effect)

        llm = OpenAICompatibleLLM(settings, client=mock_client)
        result = await llm.complete_json(system_prompt="sys", user_prompt="hi")
        self.assertEqual(result["action"], "final")
        self.assertEqual(call_count, 2)


class StableQuestionWithoutWebSearchTests(unittest.IsolatedAsyncioTestCase):
    """Stable educational questions must not depend on web_search credentials."""

    async def test_stable_question_succeeds_without_web_search(self):
        # Use scripted LLM that answers directly, no tools needed
        from agent.engine import AgentEngine
        from config import Settings

        class ScriptedLLM:
            async def complete_json(self, **kwargs):
                return {
                    "action": "final",
                    "answer": "Machine learning is a field of AI that enables computers to learn from data without explicit programming.",
                    "stateUpdate": {"confidence": "HIGH"},
                }

        settings = Settings(
            llm_api_key="test-key",
            llm_model="test-model",
            llm_base_url="https://llm.example.invalid/v1",
            llm_timeout_seconds=5,
            llm_max_output_tokens=256,
            llm_temperature=0.2,
            llm_json_mode=True,
            web_search_api_key="",  # intentionally missing
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
            conversation_ttl_seconds=3600,
            ai_internal_token="",
            ai_require_internal_token=False,
            cors_origins=("http://localhost:5173",),
        )
        # Build registry without web search configured - it should still allow agent to answer
        from agent.tools import build_web_tools

        registry = ToolRegistry()
        for definition in build_web_tools(settings):
            registry.register(definition)
        # The registry will have no tools registered because search not configured, or limited.
        # Agent should still succeed with direct answer.
        engine = AgentEngine(settings, ScriptedLLM(), registry)
        result = await engine.run(goal="what is ml", conversation=[], conversation_id="test-conversation-123456")
        self.assertTrue(result.success)
        self.assertIn("Machine learning", result.message)
        self.assertFalse(result.used_web)

    async def test_explain_supervised_learning_stable(self):
        from config import Settings

        class ScriptedLLM:
            async def complete_json(self, **kwargs):
                return {
                    "action": "final",
                    "answer": "Supervised learning is a type of machine learning where a model learns from labeled examples.",
                    "stateUpdate": {"confidence": "HIGH"},
                }

        settings = Settings(
            llm_api_key="test-key",
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
            conversation_ttl_seconds=3600,
            ai_internal_token="",
            ai_require_internal_token=False,
            cors_origins=("http://localhost:5173",),
        )
        from agent.tools import build_web_tools

        registry = ToolRegistry()
        for d in build_web_tools(settings):
            registry.register(d)
        engine = AgentEngine(settings, ScriptedLLM(), registry)
        result = await engine.run(goal="explain supervised learning", conversation=[], conversation_id="test-conv-1234567890")
        self.assertTrue(result.success)
        self.assertIn("Supervised", result.message)


class ProviderErrorFrontendContractTests(unittest.IsolatedAsyncioTestCase):
    """Frontend must receive structured backend errors without unhandled rejections."""

    def test_safe_error_classification_401(self):
        # Import _safe_error from main after patching settings
        from main import _safe_error
        from agent.llm import LLMResponseError

        exc = LLMResponseError("auth failed", status_code=401, error_type="authentication_error", provider_message="Incorrect API key")
        status, code, msg = _safe_error(exc)
        self.assertEqual(status, 503)
        self.assertEqual(code, "LLM_AUTHENTICATION_FAILED")
        self.assertIn("authentication", msg.lower())

    def test_safe_error_classification_429(self):
        from main import _safe_error
        from agent.llm import LLMResponseError

        exc = LLMResponseError("rate limit", status_code=429, error_type="rate_limit", provider_message="Too many requests")
        status, code, msg = _safe_error(exc)
        self.assertEqual(status, 429)
        self.assertEqual(code, "LLM_RATE_LIMITED")

    def test_safe_error_classification_404_model(self):
        from main import _safe_error
        from agent.llm import LLMResponseError

        exc = LLMResponseError("not found", status_code=404, error_type="not_found", provider_message="The model `gpt-4.1-mini` does not exist")
        status, code, msg = _safe_error(exc)
        self.assertEqual(status, 503)
        self.assertIn("model", msg.lower())
        self.assertEqual(code, "LLM_MODEL_NOT_FOUND")

    def test_safe_error_classification_timeout(self):
        from main import _safe_error
        from agent.llm import LLMResponseError

        exc = LLMResponseError("timeout", status_code=504, error_type="timeout", provider_message="timeout")
        status, code, msg = _safe_error(exc)
        self.assertEqual(status, 504)

    def test_safe_error_configuration(self):
        from main import _safe_error
        from agent.llm import LLMConfigurationError

        exc = LLMConfigurationError("not configured")
        status, code, msg = _safe_error(exc)
        self.assertEqual(status, 503)
        self.assertIn("not configured", msg.lower())


class SanitizationTests(unittest.TestCase):
    def test_sanitize_removes_html(self):
        html = "<html><body>Error <b>500</b> internal</body></html>"
        sanitized = _sanitize_provider_message(html)
        self.assertNotIn("<", sanitized)
        self.assertNotIn(">", sanitized)
        self.assertIn("500", sanitized)

    def test_sanitize_redacts_key(self):
        text = "Invalid api key sk-proj-1234567890abcdef provided"
        sanitized = _sanitize_provider_message(text)
        self.assertNotIn("sk-proj", sanitized)
        self.assertIn("[redacted", sanitized)

    def test_parse_json_object_with_wrapped_text(self):
        text = 'Here is your answer: {"action":"final","answer":"hello"} thanks!'
        parsed = parse_json_object(text)
        self.assertEqual(parsed["action"], "final")


if __name__ == "__main__":
    unittest.main()
