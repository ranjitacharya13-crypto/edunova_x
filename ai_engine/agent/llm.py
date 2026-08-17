"""Small OpenAI-compatible LLM client used by the planner.

The agent is provider-neutral: OpenAI, Azure-compatible gateways, Groq,
OpenRouter, and Gemini's OpenAI-compatible endpoint can be selected entirely
through server-side environment variables.
"""

from __future__ import annotations

import asyncio
import json
import re
from typing import Any

import httpx

from config import Settings


class LLMConfigurationError(RuntimeError):
    pass


class LLMResponseError(RuntimeError):
    pass


def parse_json_object(text: str) -> dict[str, Any]:
    candidate = (text or "").strip()
    if candidate.startswith("```"):
        candidate = re.sub(r"^```(?:json)?\s*", "", candidate, flags=re.IGNORECASE)
        candidate = re.sub(r"\s*```$", "", candidate)
    try:
        parsed = json.loads(candidate)
        if isinstance(parsed, dict):
            return parsed
    except json.JSONDecodeError:
        pass

    # Compatibility fallback for providers that wrap an otherwise valid JSON
    # object in one short sentence. Decoder.raw_decode avoids a greedy regex.
    decoder = json.JSONDecoder()
    for match in re.finditer(r"\{", candidate):
        try:
            parsed, _ = decoder.raw_decode(candidate[match.start() :])
            if isinstance(parsed, dict):
                return parsed
        except json.JSONDecodeError:
            continue
    raise LLMResponseError("The model did not return a valid decision object")


class OpenAICompatibleLLM:
    def __init__(self, settings: Settings, client: httpx.AsyncClient | None = None):
        self.settings = settings
        self._client = client

    async def complete_json(
        self,
        *,
        system_prompt: str,
        user_prompt: str,
        retries: int = 2,
    ) -> dict[str, Any]:
        if not self.settings.llm_configured:
            raise LLMConfigurationError(
                "EduNova AI is not configured. Set LLM_API_KEY, LLM_MODEL, and LLM_BASE_URL on the AI service."
            )

        payload: dict[str, Any] = {
            "model": self.settings.llm_model,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            "temperature": self.settings.llm_temperature,
            "max_tokens": self.settings.llm_max_output_tokens,
        }
        if self.settings.llm_json_mode:
            payload["response_format"] = {"type": "json_object"}

        last_error: Exception | None = None
        for attempt in range(retries + 1):
            try:
                return await self._request(payload)
            except (httpx.TimeoutException, httpx.NetworkError, LLMResponseError) as exc:
                last_error = exc
                if attempt >= retries:
                    break
                await asyncio.sleep(0.35 * (2**attempt))
            except httpx.HTTPStatusError as exc:
                last_error = exc
                status = exc.response.status_code
                # Some compatible providers reject response_format. Retry once
                # without it; this does not alter the agent's decision process.
                if status == 400 and "response_format" in payload:
                    payload.pop("response_format", None)
                    continue
                if status not in {408, 429, 500, 502, 503, 504} or attempt >= retries:
                    break
                await asyncio.sleep(0.5 * (2**attempt))

        if isinstance(last_error, httpx.HTTPStatusError):
            status = last_error.response.status_code
            raise LLMResponseError(f"LLM provider returned HTTP {status}") from last_error
        raise LLMResponseError("LLM provider is temporarily unavailable") from last_error

    async def _request(self, payload: dict[str, Any]) -> dict[str, Any]:
        headers = {
            "Authorization": f"Bearer {self.settings.llm_api_key}",
            "Content-Type": "application/json",
        }
        owns_client = self._client is None
        client = self._client or httpx.AsyncClient(
            timeout=httpx.Timeout(self.settings.llm_timeout_seconds),
            follow_redirects=False,
        )
        try:
            response = await client.post(
                f"{self.settings.llm_base_url}/chat/completions",
                headers=headers,
                json=payload,
            )
            response.raise_for_status()
            data = response.json()
            content = data.get("choices", [{}])[0].get("message", {}).get("content", "")
            if isinstance(content, list):
                content = "".join(
                    str(part.get("text", "")) if isinstance(part, dict) else str(part)
                    for part in content
                )
            return parse_json_object(str(content))
        finally:
            if owns_client:
                await client.aclose()
