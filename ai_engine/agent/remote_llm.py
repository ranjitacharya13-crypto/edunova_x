"""Authenticated HTTP/SSE client for the persistent EduNova inference service.

This is the ONLY way the lightweight orchestrator (``main.py``) reaches the
self-hosted model. It never imports llama_cpp or torch and never loads
weights. It implements the same contract the planner / router already use:

    probe(deep=False)      -> raises LLMResponseError when the model is not READY
    complete_json(...)     -> grammar-constrained JSON decision (dict)
    complete_text(...)     -> plain text; ``on_token`` receives real streamed tokens

Every failure is mapped to a precise machine-readable code the API gateway and
the frontend surface verbatim (MODEL_NOT_READY, MODEL_LOADING,
MODEL_RESOURCE_INSUFFICIENT, MODEL_FAILED, AI_SERVICE_UNREACHABLE,
INFERENCE_FAILED, MODEL_BUSY, AUTH_FAILED). Nothing is ever faked.
"""
from __future__ import annotations

import json
import logging
import time
from typing import Any

import httpx

from config import Settings
from .llm import LLMConfigurationError, LLMResponseError, parse_json_object

logger = logging.getLogger("edunova.llm.remote")

_DECISION_SCHEMA_NAME = "decision"


class RemoteInferenceLLM:
    """Planner/router-compatible LLM backed by the inference service."""

    is_local = True  # self-hosted; keeps the compact-prompt behaviour in the planner
    is_remote_inference = True

    def __init__(self, settings: Settings, client: httpx.AsyncClient | None = None):
        self.settings = settings
        self.base_url = str(settings.inference_url or "").rstrip("/")
        self._client = client
        self.last_status: dict[str, Any] | None = None
        self.last_generation_metrics: dict[str, Any] | None = None
        self.last_status_at: float | None = None
        self.last_connect_ms: int | None = None

    # ------------------------------------------------------------ helpers --
    def _headers(self, request_id: str | None = None, accept: str = "application/json") -> dict[str, str]:
        headers = {"Content-Type": "application/json", "Accept": accept}
        if self.settings.ai_internal_token:
            headers["X-AI-Internal-Token"] = self.settings.ai_internal_token
        if request_id:
            headers["X-Request-Id"] = str(request_id)[:80]
        return headers

    def _require_config(self) -> None:
        if not self.base_url:
            raise LLMConfigurationError(
                "AI_INFERENCE_URL is not configured: the orchestrator does not know where the inference service runs"
            )

    def _client_or_new(self, timeout: float) -> tuple[httpx.AsyncClient, bool]:
        if self._client is not None:
            return self._client, False
        return httpx.AsyncClient(timeout=httpx.Timeout(timeout, connect=10.0), follow_redirects=False), True

    @staticmethod
    def _error_from_payload(status: int, payload: Any) -> LLMResponseError:
        detail = payload.get("detail") if isinstance(payload, dict) else None
        if isinstance(detail, dict):
            payload = detail
        code = None
        message = None
        if isinstance(payload, dict):
            code = payload.get("code") or payload.get("error") or payload.get("errorStage") or payload.get("publicState")
            if isinstance(code, dict):
                code = code.get("code")
            message = payload.get("message") or payload.get("lastError") or payload.get("detail")
        if not code:
            code = {401: "AUTH_FAILED", 403: "AUTH_FAILED", 429: "MODEL_BUSY", 503: "MODEL_NOT_READY"}.get(status, "INFERENCE_FAILED")
        message = str(message or f"Inference service returned HTTP {status}")[:500]
        return LLMResponseError(message, status_code=status if status >= 400 else 502, error_type=str(code))

    @staticmethod
    def _network_error(exc: Exception) -> LLMResponseError:
        if isinstance(exc, httpx.TimeoutException):
            return LLMResponseError("The inference service did not respond in time", status_code=504,
                                    error_type="UPSTREAM_TIMEOUT", provider_message=type(exc).__name__)
        return LLMResponseError("The inference service is unreachable", status_code=503,
                                error_type="AI_SERVICE_UNREACHABLE", provider_message=type(exc).__name__)

    # -------------------------------------------------------------- probes --
    async def status(self, timeout: float = 8.0) -> dict[str, Any]:
        """GET /model/status (authenticated). Never raises for a non-ready model."""
        self._require_config()
        client, own = self._client_or_new(timeout)
        started = time.monotonic()
        try:
            response = await client.get(f"{self.base_url}/model/status", headers=self._headers())
            self.last_connect_ms = int((time.monotonic() - started) * 1000)
            payload = response.json() if response.content else {}
            if response.status_code in {401, 403}:
                raise self._error_from_payload(response.status_code, payload)
            payload = dict(payload) if isinstance(payload, dict) else {}
            payload.setdefault("httpStatus", response.status_code)
            self.last_status, self.last_status_at = payload, time.time()
            return payload
        except httpx.HTTPError as exc:
            self.last_connect_ms = int((time.monotonic() - started) * 1000)
            raise self._network_error(exc) from exc
        finally:
            if own:
                await client.aclose()

    async def probe(self, deep: bool = False) -> None:
        payload = await self.status()
        if payload.get("state") in {"READY", "MODEL_READY"} and payload.get("model_loaded") and payload.get("warmup_complete") and payload.get("inference_test"):
            if deep:
                await self.complete_text(system_prompt="Answer briefly.", user_prompt="What is 2 + 2?", max_output_tokens=24)
            return
        raise self._not_ready(payload)

    @staticmethod
    def _not_ready(payload: dict[str, Any]) -> LLMResponseError:
        state = str(payload.get("state") or "MODEL_NOT_READY")
        code = payload.get("errorStage") or payload.get("error_code") or state
        if state == "MODEL_FAILED":
            code = payload.get("errorStage") or "MODEL_FAILED"
        message = payload.get("error") or payload.get("lastError") or (
            "AI temporarily unavailable because the inference service is starting" if state == "MODEL_LOADING"
            else f"Inference service is not ready ({state})")
        return LLMResponseError(str(message)[:500], status_code=503, error_type=str(code))

    # ---------------------------------------------------------- generation --
    async def _generate(self, *, system_prompt: str, user_prompt: str, max_tokens: int, temperature: float | None,
                        json_schema: dict[str, Any] | None, on_token: Any = None, request_id: str | None = None) -> str:
        self._require_config()
        body = {"system_prompt": system_prompt, "user_prompt": user_prompt, "max_tokens": int(max_tokens),
                "temperature": temperature, "json_schema": json_schema, "stream": on_token is not None}
        timeout = float(self.settings.inference_request_timeout)
        client, own = self._client_or_new(timeout)
        started = time.monotonic()
        try:
            if on_token is None:
                response = await client.post(f"{self.base_url}/generate", json=body, headers=self._headers(request_id))
                payload = response.json() if response.content else {}
                if response.status_code >= 400:
                    raise self._error_from_payload(response.status_code, payload)
                self.last_generation_metrics = payload.get("metrics")
                text = str(payload.get("text") or "")
                if not text.strip():
                    raise LLMResponseError("The model returned an empty response", status_code=502, error_type="INVALID_MODEL_OUTPUT")
                return text
            pieces: list[str] = []
            final: dict[str, Any] | None = None
            async with client.stream("POST", f"{self.base_url}/generate/stream", json=body,
                                     headers=self._headers(request_id, accept="text/event-stream")) as response:
                if response.status_code >= 400:
                    raw = await response.aread()
                    try:
                        payload = json.loads(raw.decode("utf-8") or "{}")
                    except ValueError:
                        payload = {}
                    raise self._error_from_payload(response.status_code, payload)
                async for line in response.aiter_lines():
                    if not line.startswith("data:"):
                        continue
                    try:
                        event = json.loads(line[5:].strip())
                    except ValueError:
                        continue
                    kind = event.get("type")
                    if kind == "token":
                        delta = str(event.get("delta") or "")
                        if delta:
                            pieces.append(delta)
                            on_token(delta)
                    elif kind == "done":
                        final = event
                    elif kind == "error":
                        err = event.get("error") or {}
                        raise LLMResponseError(str(event.get("message") or err.get("message") or "Inference failed")[:500],
                                               status_code=int(event.get("status") or 502), error_type=str(err.get("code") or "INFERENCE_FAILED"))
            if final is None:
                raise LLMResponseError("The inference stream ended before the answer completed", status_code=502, error_type="STREAM_INTERRUPTED")
            self.last_generation_metrics = final.get("metrics")
            text = str(final.get("text") or "".join(pieces))
            if not text.strip():
                raise LLMResponseError("The model returned an empty response", status_code=502, error_type="INVALID_MODEL_OUTPUT")
            return text
        except httpx.HTTPError as exc:
            raise self._network_error(exc) from exc
        finally:
            logger.info("REMOTE_INFERENCE_CALL json=%s stream=%s duration_ms=%s", bool(json_schema), on_token is not None,
                        int((time.monotonic() - started) * 1000))
            if own:
                await client.aclose()

    async def complete_json(self, *, system_prompt: str, user_prompt: str, retries: int = 2,
                            max_output_tokens: int | None = None, json_schema: dict[str, Any] | None = None) -> dict[str, Any]:
        from .local_llm import DECISION_SCHEMA  # pure data; no llama_cpp import at module level
        schema = json_schema if json_schema is not None else DECISION_SCHEMA
        max_tokens = max_output_tokens or min(self.settings.llm_max_output_tokens, 480)
        last_error: Exception | None = None
        for attempt in range(retries + 1):
            try:
                text = await self._generate(system_prompt=system_prompt, user_prompt=user_prompt, max_tokens=max_tokens,
                                            temperature=None, json_schema=schema)
                return parse_json_object(text)
            except LLMResponseError as exc:
                last_error = exc
                if exc.error_type in {"invalid_response", "INVALID_MODEL_OUTPUT"} and attempt < retries:
                    logger.info("REMOTE_MODEL_JSON_RETRY attempt=%s", attempt + 1)
                    continue
                raise
        assert last_error is not None
        raise last_error

    async def complete_text(self, *, system_prompt: str, user_prompt: str, max_output_tokens: int | None = None,
                            temperature: float | None = None, on_token: Any = None) -> str:
        return await self._generate(system_prompt=system_prompt, user_prompt=user_prompt,
                                    max_tokens=max_output_tokens or self.settings.llm_max_output_tokens,
                                    temperature=temperature, json_schema=None, on_token=on_token)


def create_llm(settings: Settings) -> RemoteInferenceLLM:
    """The orchestrator only ever talks to the inference service."""
    if settings.llm_provider != "local":
        raise LLMConfigurationError("EduNova AI is self-hosted only; commercial LLM providers are not supported")
    return RemoteInferenceLLM(settings)
