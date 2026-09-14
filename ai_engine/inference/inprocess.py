"""EduNova OWNED IN-PROCESS MODEL ENGINE.

This module makes the EduNova AI service own its complete model lifecycle in
the SAME application: the orchestrator process is the single owner of exactly
one supervised ``ModelManager`` (``inference/manager.py``), which keeps the
GGUF weights + llama.cpp runtime in a child worker it spawned itself. No
external inference service exists in this topology: nothing is downloaded,
loaded, warmed or executed outside the EduNova AI architecture. llama.cpp is
integrated strictly as an INTERNAL LIBRARY (``llama-cpp-python``), never as a
separate service.

Why a supervised worker instead of importing llama_cpp directly into the
FastAPI event loop: native llama.cpp calls cannot be interrupted from
asyncio, so a stalled generation would wedge the whole AI service. The
supervisor can terminate/reap its own child, keeps the lifecycle state machine
(BOOT → … → READY → SERVING, with named terminal failures), and enforces
single-flight admission — there is always EXACTLY ONE model instance per AI
process.

This engine implements the SAME contract the planner / router / orchestrator
already consume (the ``RemoteInferenceLLM`` interface):

    status()               -> lifecycle payload (never raises for live states)
    probe(deep=False)      -> raises LLMResponseError when not truly READY
    complete_json(...)     -> grammar-constrained JSON decision (dict)
    complete_text(...)     -> plain text; ``on_token`` receives real tokens

so ``main.py`` can hold either engine behind one variable. ``is_remote_inference``
is False here: every inference hop is an in-process call, not an HTTP hop.
"""
from __future__ import annotations

import logging
import time
from typing import Any

from agent.llm import LLMConfigurationError, LLMResponseError, parse_json_object
from config import Settings
from inference.manager import FAILURES, ModelManager, model_requirement, public_state, safe_error
from inference.resources import ResourceManager

logger = logging.getLogger("edunova.llm.inprocess")

# Mirror of the per-request JSON retry contract used for remote inference.
_MAX_JSON_RETRIES = 2


class InProcessLLM:
    """Planner/router-compatible LLM backed by the model THIS process owns."""

    is_local = True  # self-hosted; keeps compact-prompt behaviour in the planner
    is_remote_inference = False

    def __init__(self, settings: Settings, manager: ModelManager | None = None):
        self.settings = settings
        # Exactly one supervisor instance per AI process. ModelManager itself
        # refuses a second lifecycle (``ensure_loading`` is single-flight) and
        # refuses concurrent generations (bounded admission, MODEL_BUSY).
        self.manager = manager or ModelManager(settings)
        self._resource_manager = ResourceManager(settings.local_model_dir)
        self.last_status: dict[str, Any] | None = None
        self.last_generation_metrics: dict[str, Any] | None = None
        self.last_status_at: float | None = None
        self.last_connect_ms: int = 0

    # ------------------------------------------------------------ startup --
    def start(self) -> None:
        """Begin the single model lifecycle (idempotent; safe to re-call).

        Called once from the app lifespan so weights download/load/warm while
        the port is already answering. Requests that arrive early observe
        MODEL_LOADING and fail fast with a precise, retryable state — they are
        never queued against a half-loaded model and never start a second load.
        """
        self.manager.ensure_loading()

    # ------------------------------------------------------------- status --
    async def status(self, timeout: float = 8.0) -> dict[str, Any]:
        """Current model lifecycle, in the exact shape /model/status serves.

        Never raises for a live (loading/unready) state: health endpoints must
        observe reality, and the ready-gate turns the state into the precise
        public error. Async to match the RemoteInferenceLLM interface exactly.
        ``last_connect_ms`` is 0 by definition — the hop is an in-process call,
        not a network round trip.
        """
        manager = self.manager
        snap = manager.snapshot(include_source=True)
        ready = manager.is_ready()
        state = public_state(manager.phase)
        payload: dict[str, Any] = {
            "state": state,
            "lifecycle": manager.phase,
            "model_loaded": bool(snap.get("modelLoaded")),
            "tokenizer_loaded": bool(snap.get("tokenizerLoaded")),
            "warmup_complete": bool(snap.get("warmupComplete")),
            "inference_test": bool(snap.get("inferenceTest")),
            "ready": ready,
            "reachable": True,
            "httpStatus": 200,
            "model": snap.get("modelId"),
            "runtime": settings_runtime_label(self.settings),
            "runtime_version": snap.get("runtimeVersion"),
            "quantization": snap.get("quantization") or (snap.get("memoryRequirement") or {}).get("quantization"),
            "context_size": snap.get("contextSize"),
            "threads": snap.get("threads"),
            "file_size_bytes": snap.get("fileSizeBytes"),
            "memory_requirement": snap.get("memoryRequirement"),
            "model_load_ms": snap.get("modelLoadMs"),
            "warmup_ms": snap.get("warmupMs"),
            "cold_start_ms": snap.get("coldStartMs"),
            "startup_duration_ms": snap.get("startupDurationMs"),
            "startup_timeout_seconds": snap.get("startupTimeoutSeconds"),
            "last_self_test": snap.get("lastSelfTest"),
            "last_generation": snap.get("lastGeneration"),
            "download": {
                "attempts": snap.get("downloadAttempts"),
                "downloaded_bytes": snap.get("downloadedBytes"),
                "expected_bytes": snap.get("expectedSizeBytes"),
                "cache_reused": bool(snap.get("downloadAttempts") == 0 and snap.get("fileSizeBytes")),
            },
            # Top-level progress fields consumed by the frontend status hook
            # (describeModelProgress) so the UI shows real download percentages.
            "downloadedBytes": snap.get("downloadedBytes"),
            "expectedSizeBytes": snap.get("expectedSizeBytes"),
            "storage": snap.get("storage"),
            "available_ram_mb": self._resource_manager.snapshot().get("ram_available_mb"),
            "history": snap.get("history", []),
            "permanentFailure": manager.phase in FAILURES,
            "error": None if ready else (snap.get("lastError") or None),
            "errorStage": None if ready else (snap.get("errorDetail") or None),
            "mode": "in-process",
        }
        if manager.phase == "MODEL_RESOURCE_INSUFFICIENT" and isinstance(manager.error_report, dict):
            payload["resource"] = {k: manager.error_report.get(k)
                                   for k in ("error", "required_mb", "available_mb", "recommended_mb", "breakdown")}
        self.last_status, self.last_status_at = payload, time.time()
        return payload

    async def probe(self, deep: bool = False) -> None:
        """Raise unless the owned model can genuinely answer right now."""
        payload = await self.status()
        if payload.get("state") in {"READY", "MODEL_READY"} and payload.get("model_loaded") \
                and payload.get("warmup_complete") and payload.get("inference_test"):
            if deep:
                await self.complete_text(system_prompt="Answer briefly.", user_prompt="What is 2 + 2?",
                                         max_output_tokens=24)
            return
        raise self._not_ready(payload)

    @staticmethod
    def _not_ready(payload: dict[str, Any]) -> LLMResponseError:
        state = str(payload.get("state") or "MODEL_NOT_READY")
        code = payload.get("errorStage") or payload.get("error_code") or state
        if state == "MODEL_FAILED":
            code = payload.get("errorStage") or "MODEL_FAILED"
        message = payload.get("error") or (
            "AI temporarily unavailable because the model is starting"
            if state == "MODEL_LOADING"
            else f"Inference service is not ready ({state})")
        return LLMResponseError(str(message)[:500], status_code=503, error_type=str(code))

    # ---------------------------------------------------------- generation --
    async def _generate(self, *, system_prompt: str, user_prompt: str, max_tokens: int,
                        temperature: float | None, json_schema: dict[str, Any] | None,
                        on_token: Any = None, request_id: str | None = None) -> str:
        if self.settings.llm_configuration_error:
            raise LLMConfigurationError(f"Invalid model configuration: {self.settings.llm_configuration_error}")
        if not self.manager.is_ready():
            raise self._not_ready(await self.status())
        started = time.monotonic()
        try:
            text = await self.manager.generate(
                system_prompt=system_prompt,
                user_prompt=user_prompt,
                max_tokens=int(max_tokens),
                temperature=temperature,
                json_schema=json_schema,
                on_token=on_token,
            )
            self.last_generation_metrics = self.manager.last_generation_metrics
            logger.info("INPROCESS_INFERENCE_CALL json=%s stream=%s duration_ms=%s request_id=%s",
                        bool(json_schema), on_token is not None,
                        int((time.monotonic() - started) * 1000), str(request_id or "")[:80])
            return text
        except LLMResponseError:
            raise

    async def complete_json(self, *, system_prompt: str, user_prompt: str, retries: int = _MAX_JSON_RETRIES,
                            max_output_tokens: int | None = None,
                            json_schema: dict[str, Any] | None = None) -> dict[str, Any]:
        from agent.local_llm import DECISION_SCHEMA  # pure data; no llama_cpp import at module level
        schema = json_schema if json_schema is not None else DECISION_SCHEMA
        max_tokens = max_output_tokens or min(self.settings.llm_max_output_tokens, 480)
        last_error: Exception | None = None
        for attempt in range(retries + 1):
            try:
                text = await self._generate(system_prompt=system_prompt, user_prompt=user_prompt,
                                            max_tokens=max_tokens, temperature=None, json_schema=schema)
                return parse_json_object(text)
            except LLMResponseError as exc:
                last_error = exc
                if exc.error_type in {"invalid_response", "INVALID_MODEL_OUTPUT"} and attempt < retries:
                    logger.info("INPROCESS_MODEL_JSON_RETRY attempt=%s", attempt + 1)
                    continue
                raise
        assert last_error is not None
        raise last_error

    async def complete_text(self, *, system_prompt: str, user_prompt: str,
                            max_output_tokens: int | None = None, temperature: float | None = None,
                            on_token: Any = None) -> str:
        text = await self._generate(system_prompt=system_prompt, user_prompt=user_prompt,
                                    max_tokens=max_output_tokens or self.settings.llm_max_output_tokens,
                                    temperature=temperature, json_schema=None, on_token=on_token)
        return text

    # -------------------------------------------------------------- close --
    async def close(self) -> None:
        await self.manager.close()


def settings_runtime_label(settings: Settings) -> str:
    """Runtime label surfaced in health payloads (never a secret)."""
    return settings.local_model_runtime
