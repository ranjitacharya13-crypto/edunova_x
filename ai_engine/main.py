"""EduNova AI ORCHESTRATOR (Layer A — lightweight, no model in this process).

This service owns AI orchestration only: intent routing, the ToolRegistry
(authenticated EduNova data tools), RAG orchestration, web search, bounded
conversation memory, application actions and the SSE streaming gateway.

It NEVER loads the LLM and never imports llama_cpp or torch. The self-hosted
model runs in the separate persistent inference service
(``inference_server.py``); this process reaches it through the authenticated
HTTP/SSE client in ``agent/remote_llm.py`` (``AI_INFERENCE_URL`` +
``AI_INTERNAL_TOKEN``). No OpenAI/Groq/Gemini/Anthropic/OpenRouter calls are
made anywhere: web search is data, the reasoning model stays self-hosted.
"""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
import json
import logging
import os
from pathlib import Path
import secrets
import time
from typing import Any
from datetime import datetime, timezone

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, ConfigDict, Field

# Local development convenience only. Production injects environment variables.
try:
    from dotenv import load_dotenv

    load_dotenv(Path(__file__).resolve().parent / ".env")
    load_dotenv(Path(__file__).resolve().parents[1] / "server" / ".env")
except ImportError:
    pass

from agent.engine import AgentEngine
from agent.llm import LLMConfigurationError, LLMResponseError
from agent.memory import ConversationStore
from agent.remote_llm import RemoteInferenceLLM, create_llm
from agent.router import FAST_INTENTS, IntentRouter, run_fast_path
from agent.tools import ToolRegistry, build_all_tools
from config import load_settings
from inference.resources import ResourceManager

logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
logger = logging.getLogger("edunova.api")
settings = load_settings()


# ---------------------------------------------------------------------------
# Observability: request ids + production metrics (no secrets ever).
# ---------------------------------------------------------------------------
def _new_request_id() -> str:
    return secrets.token_hex(16)


_METRICS: dict[str, Any] = {
    "request_count": 0,
    "success_count": 0,
    "error_count": 0,
    "model_load_time_ms": None,
    "cold_start_time_ms": None,
    "first_token_latency_ms": None,
    "generation_time_ms": None,
    "tokens_generated": 0,
    "tokens_per_second": None,
    "tool_latency_ms": 0.0,
    "database_latency_ms": 0.0,
    "web_latency_ms": 0.0,
    "total_request_latency_ms": 0.0,
    "queue_time_ms": 0.0,
    "request_count_by_intent": {},
    "model_memory_usage_bytes": None,
    "cpu_usage_percent": None,
    "started_at": datetime.now(timezone.utc).isoformat(),
    "latency_count": 0,
}


def _bump_metric(key: str, amount: float = 1.0) -> None:
    try:
        _METRICS[key] = float(_METRICS.get(key) or 0.0) + amount
    except (TypeError, ValueError):
        pass


def _record_latency(metric_key: str, milliseconds: float) -> None:
    """Exponential-moving average latency (robust without a histogram lib)."""
    key = f"ema_{metric_key}"
    count_key = f"count_{metric_key}"
    try:
        previous = float(_METRICS.get(key) or 0.0)
        count = int(_METRICS.get(count_key) or 0)
        _METRICS[count_key] = count + 1
        if count == 0:
            _METRICS[key] = float(milliseconds)
        else:
            _METRICS[key] = (0.8 * previous) + (0.2 * float(milliseconds))
    except (TypeError, ValueError):
        pass


def _process_resources() -> dict[str, Any]:
    """Best-effort RSS + CPU percent (no psutil dependency)."""
    rss_bytes = None
    try:
        with open(f"/proc/{os.getpid()}/status", encoding="utf-8") as handle:
            for line in handle:
                if line.startswith("VmRSS:"):
                    rss_bytes = int(line.split()[1]) * 1024
                    break
    except (OSError, ValueError):
        pass
    cpu_percent = None
    try:
        with open("/proc/stat", encoding="utf-8") as handle:
            first = [int(value) for value in handle.readline().split()[1:]]
        time.sleep(0.05)
        with open("/proc/stat", encoding="utf-8") as handle:
            second = [int(value) for value in handle.readline().split()[1:]]
        delta = sum(second) - sum(first)
        if delta > 0:
            idle_delta = (second[3] - first[3]) + (second[4] - first[4])
            cpu_percent = round(min(100.0, max(0.0, (1 - idle_delta / delta) * 100.0)), 2)
    except (OSError, ValueError, IndexError):
        pass
    return {"rssBytes": rss_bytes, "cpuPercent": cpu_percent}


# --- Safe startup diagnostics (no secrets) ---
def _log_startup_diagnostics() -> None:
    logger.info(
        "AI_ORCHESTRATOR_STARTUP provider=%s inference_url_configured=%s internal_auth_required=%s search_configured=%s rag_enabled=%s",
        settings.llm_provider,
        bool(settings.inference_url),
        settings.ai_require_internal_token,
        settings.search_configured,
        settings.rag_enabled,
    )
    if not settings.inference_url:
        logger.error(
            "CONFIG_FAILED code=AI_INFERENCE_URL_MISSING hint=Set AI_INFERENCE_URL to the persistent "
            "inference service (inference_server.py). This process never loads the model itself. "
            "The service refuses to start until it is set — see _require_runtime_configuration()."
        )
    if settings.ai_require_internal_token and not settings.ai_internal_token:
        logger.error(
            "CONFIG_FAILED code=AI_INTERNAL_TOKEN_MISSING hint=AI_REQUIRE_INTERNAL_TOKEN is true but "
            "AI_INTERNAL_TOKEN is empty. Use the same random value on edunova-api, edunova-ai and "
            "edunova-inference."
        )
    stale_external = [name for name in ("LLM_API_KEY", "LLM_BASE_URL", "LLM_MODEL") if os.getenv(name, "").strip()]
    if stale_external:
        logger.warning("STALE_EXTERNAL_LLM_ENV detected=%s hint=EduNova AI is self-hosted; these variables are ignored", ",".join(stale_external))


_log_startup_diagnostics()


class OrchestratorStartupError(RuntimeError):
    """A configuration that makes chat impossible, raised at STARTUP.

    Failing here rather than on the first student message is the point: the
    Render deploy goes red immediately and the deploy log carries a
    machine-readable code, instead of the service reporting a green
    ``/health`` and answering the first chat with a 503.
    """

    def __init__(self, code: str, message: str) -> None:
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message


def _require_runtime_configuration() -> None:
    """Refuse to serve traffic when the orchestrator cannot reach the model.

    These are the only two configuration errors that are unrecoverable at
    runtime. Everything else (inference service down, model still loading,
    resources too small) is a live state reported per request, never fatal at
    boot, because the inference service may legitimately be starting later.
    """
    if not settings.inference_url:
        raise OrchestratorStartupError(
            "AI_INFERENCE_URL_MISSING",
            "AI_INFERENCE_URL is not configured. The orchestrator never loads the model "
            "itself: set AI_INFERENCE_URL on edunova-ai to the public HTTPS URL of the "
            "persistent inference service (edunova-inference), with no trailing slash.",
        )
    if settings.ai_require_internal_token and not settings.ai_internal_token:
        raise OrchestratorStartupError(
            "AI_INTERNAL_TOKEN_MISSING",
            "AI_REQUIRE_INTERNAL_TOKEN is true but AI_INTERNAL_TOKEN is empty. Set the same "
            "random AI_INTERNAL_TOKEN on edunova-api, edunova-ai and edunova-inference.",
        )


def _inference_host() -> str:
    """The inference service host for logs. Never the token, never a full URL."""
    raw = str(settings.inference_url or "")
    if not raw:
        return "unset"
    without_scheme = raw.split("://", 1)[-1]
    return without_scheme.split("/", 1)[0].split("@", 1)[-1]


registry = ToolRegistry(
    allowed_permissions={"READ_INTERNAL", "WRITE_INTERNAL", "READ_EXTERNAL", "UTILITY"}
)
for definition in build_all_tools(settings):
    registry.register(definition)

# The model lives in the inference service. This client is the only bridge.
llm: RemoteInferenceLLM = create_llm(settings)
agent = AgentEngine(settings, llm, registry)
intent_router = IntentRouter(settings)
resource_manager = ResourceManager()
provider_runtime = {
    "state": "unknown",
    "lastCheckedAt": None,
    "lastHttpStatus": None,
    "lastErrorType": None,
}


def _set_provider_state(state: str, status: int | None = None, error_type: str | None = None) -> None:
    provider_runtime.update({
        "state": state,
        "lastCheckedAt": datetime.now(timezone.utc).isoformat(),
        "lastHttpStatus": status,
        "lastErrorType": error_type,
    })


# Cached inference-service status (refreshed on demand, bounded staleness) so
# health/ready endpoints stay cheap and readiness is never assumed.
_INFERENCE_STATUS_TTL = 2.0


async def _inference_status(force: bool = False) -> dict[str, Any]:
    now = time.time()
    if not force and llm.last_status is not None and llm.last_status_at and now - llm.last_status_at < _INFERENCE_STATUS_TTL:
        return llm.last_status
    # This is the single choke point for the orchestrator -> inference hop, so
    # the hop log lives here and covers BOTH the gateway's readiness probe and
    # the chat path. Bounded by the status TTL above; never logs tokens or
    # message text.
    started = time.monotonic()
    try:
        status = await llm.status()
        _set_provider_state(str(status.get("state") or "unknown"), int(status.get("httpStatus") or 200), None)
        logger.info("HOP_AI_TO_INFERENCE_OK host=%s ms=%s state=%s model_loaded=%s",
                    _inference_host(), int((time.monotonic() - started) * 1000),
                    status.get("state"), status.get("model_loaded"))
        return status
    except LLMConfigurationError as exc:
        _set_provider_state("CONFIG_FAILED", None, "CONFIG_FAILED")
        logger.error("HOP_AI_TO_INFERENCE_FAILED host=%s ms=%s code=CONFIG_FAILED",
                     _inference_host(), int((time.monotonic() - started) * 1000))
        return {"state": "CONFIG_FAILED", "error": str(exc), "errorStage": "CONFIG_FAILED", "permanentFailure": True, "reachable": False}
    except LLMResponseError as exc:
        _set_provider_state(exc.error_type, exc.status_code, exc.error_type)
        logger.error("HOP_AI_TO_INFERENCE_FAILED host=%s ms=%s code=%s http=%s",
                     _inference_host(), int((time.monotonic() - started) * 1000), exc.error_type, exc.status_code)
        return {"state": "MODEL_NOT_READY" if exc.error_type == "AI_SERVICE_UNREACHABLE" else exc.error_type,
                "error": str(exc), "errorStage": exc.error_type, "reachable": False,
                "permanentFailure": exc.error_type in {"AUTH_FAILED", "CONFIG_FAILED"}}


def _status_is_ready(status: dict[str, Any]) -> bool:
    return bool(status.get("state") in {"READY", "MODEL_READY"} and status.get("model_loaded") and status.get("warmup_complete") and status.get("inference_test"))


conversations = ConversationStore(
    max_turns=settings.conversation_max_turns,
    ttl_seconds=settings.conversation_ttl_seconds,
)


# ---------------------------------------------------------------------------
# RAG retrieval service (semantic index for EduNova learning material).
# ---------------------------------------------------------------------------
def _default_rag_persist_dir() -> Path:
    raw = Path(settings.rag_persist_dir) if settings.rag_persist_dir else Path(settings.local_model_dir) / "rag"
    if raw.is_absolute():
        return raw
    return Path(__file__).resolve().parent / raw


rag_index: Any = None
if settings.rag_enabled:
    try:
        from inference.rag import Embedder, RagIndex, RemoteEmbedder  # noqa: PLC0415

        # Embeddings are computed by the inference service (PyTorch lives
        # there). ``lexical`` is an explicit operator choice for offline dev.
        if settings.rag_embedding_model == "lexical":
            embedder: Any = Embedder("lexical")
        else:
            embedder = RemoteEmbedder(settings.inference_url, settings.ai_internal_token)
        persist = _default_rag_persist_dir()
        rag_index = RagIndex(embedder=embedder, persist_dir=str(persist))
        logger.info("RAG_INDEX_CONFIGURED persist=%s backend=%s", persist, embedder.backend)
    except Exception as exc:  # noqa: BLE001 — RAG must never block the AI service
        rag_index = None
        logger.error("RAG_INDEX_UNAVAILABLE reason=%s", str(exc)[:200])


from agent.tools.retrieval import build_retrieval_tool
registry.register(build_retrieval_tool(settings, rag_index))


@asynccontextmanager
async def lifespan(app: FastAPI):
    # No model lifecycle here. The orchestrator only OBSERVES the inference
    # service; it never downloads, loads or warms weights.
    #
    # Fatal configuration is caught BEFORE the port starts answering, so a
    # missing AI_INFERENCE_URL fails the deploy instead of the first student
    # message. uvicorn exits non-zero and Render marks the deploy failed.
    try:
        _require_runtime_configuration()
    except OrchestratorStartupError as exc:
        logger.error("ORCHESTRATOR_STARTUP_ABORTED code=%s reason=%s", exc.code, exc.message)
        raise
    logger.info("ORCHESTRATOR_STARTUP_OK inference_url_host=%s", _inference_host())

    async def observe_inference():
        status = await _inference_status(force=True)
        logger.info("INFERENCE_SERVICE_OBSERVED state=%s model=%s error=%s", status.get("state"), status.get("model"), status.get("error"))
        if rag_index is not None and _status_is_ready(status):
            try:
                await asyncio.to_thread(rag_index.embedder.load)
                rag_index.load()
                logger.info("RAG_INDEX_READY owners=%s chunks=%s backend=%s", rag_index.stats.get("owners"), rag_index.stats.get("chunks"), rag_index.embedder.backend)
            except Exception as exc:  # noqa: BLE001
                logger.error("RAG_STARTUP_DEFERRED reason=%s", str(exc)[:200])
    task = asyncio.create_task(observe_inference())
    try:
        yield
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)


app = FastAPI(
    title="EduNova AI Orchestrator",
    version="6.0.0",
    description=(
        "Lightweight AI orchestration layer: IntentRouter + authenticated ToolRegistry "
        "+ RAG orchestration + web research + bounded memory + SSE gateway. The "
        "self-hosted model runs in the separate persistent inference service "
        "(AI_INFERENCE_URL); this process never loads weights."
    ),
    lifespan=lifespan,
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=list(settings.cors_origins),
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization", "X-AI-Internal-Token"],
)


class ChatRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    message: str = Field(min_length=1, max_length=12_000)
    conversation_id: str | None = Field(default=None, alias="conversationId", max_length=100)
    owner_id: str | None = Field(default=None, alias="ownerId", max_length=200)
    user_role: str | None = Field(default="student", alias="userRole", max_length=50)
    user_name: str | None = Field(default="Student", alias="userName", max_length=100)
    user_email: str | None = Field(default=None, alias="userEmail", max_length=320)
    email: str | None = Field(default=None, max_length=320)  # Legacy client compatibility.
    application_context: dict[str, Any] = Field(default_factory=dict, alias="applicationContext")
    stream: bool = False
    request_id: str | None = Field(default=None, alias="requestId", max_length=80)
    client_started_at: float | None = Field(default=None, exclude=True)


@app.get("/")
async def root() -> dict[str, Any]:
    return {
        "success": True,
        "service": "edunova-agent",
        "version": "6.0.0",
        "architecture": "orchestrator (IntentRouter + ToolRegistry + RAG + web research) -> authenticated persistent inference service (self-hosted llama.cpp)",
        "endpoint": "POST /api/ai/chat",
    }


def _public_error(status: dict[str, Any]) -> dict[str, Any]:
    """Machine-readable failure block for gateway/frontend (never generic)."""
    if _status_is_ready(status):
        return {"code": None, "message": None}
    state = str(status.get("state") or "MODEL_NOT_READY")
    code = str(status.get("errorStage") or status.get("code") or state)
    if state == "MODEL_LOADING":
        message = "AI temporarily unavailable because the inference service is starting"
    elif state == "MODEL_FAILED" and code == "MODEL_RESOURCE_INSUFFICIENT":
        resource = status.get("resource") or {}
        message = (f"AI model resource insufficient: the inference service needs {resource.get('required_mb')} MiB "
                   f"but has {resource.get('available_mb')} MiB (recommended {resource.get('recommended_mb')} MiB)")
    else:
        message = str(status.get("error") or f"Inference service is not ready ({state})")
    return {"code": code, "message": message[:500], "resource": status.get("resource")}


@app.get("/health")
async def health() -> dict[str, Any]:
    """Liveness of the ORCHESTRATOR process + observed inference state.

    ``status: live`` means this process is up. ``modelReady`` is copied from the
    inference service's real READY state and is never inferred.
    """
    status = await _inference_status()
    ready = _status_is_ready(status)
    return {
        "status": "live",
        "service": "edunova-agent",
        "version": "6.0.0",
        "role": "orchestrator",
        "providerState": str(status.get("state") or "unknown"),
        "modelLifecycle": str(status.get("lifecycle") or status.get("state") or "unknown"),
        "modelReady": ready,
        "readyForTraffic": ready,
        "inferenceService": {
            "configured": bool(settings.inference_url),
            "reachable": status.get("reachable", True),
            "state": status.get("state"),
            "model": status.get("model"),
            "runtime": status.get("runtime"),
            "quantization": status.get("quantization"),
            "connectMs": llm.last_connect_ms,
        },
        "readiness": {
            "modelLoaded": bool(status.get("model_loaded")),
            "tokenizerLoaded": bool(status.get("tokenizer_loaded")),
            "warmupComplete": bool(status.get("warmup_complete")),
            "inferenceTest": bool(status.get("inference_test")),
            "inferenceAvailable": ready,
            "modelInitialized": ready,
        },
        "error": _public_error(status),
        "permanentFailure": bool(status.get("permanentFailure")),
        "provider": settings.llm_provider,
        "selfHosted": True,
        "webSearchConfigured": settings.search_configured,
        "ragEnabled": rag_index is not None,
        "internalAuthConfigured": bool(settings.ai_internal_token),
        "internalAuthRequired": settings.ai_require_internal_token,
        "tools": [spec["name"] for spec in registry.specs()],
        "fastPathIntents": sorted(FAST_INTENTS),
        "limits": {
            "maxIterations": settings.max_agent_iterations,
            "maxToolCalls": settings.max_tool_calls,
            "maxRuntimeSeconds": settings.max_agent_runtime_seconds,
        },
        "model": status,
    }


@app.get("/ready")
async def ready() -> Any:
    """200 only when the inference service can really answer."""
    status = await _inference_status()
    if _status_is_ready(status):
        return {"ready": True, "state": "MODEL_READY"}
    return JSONResponse(status_code=503, content={"ready": False, "state": status.get("state"), **_public_error(status)})


@app.get("/model/status")
@app.get("/api/ai/model/status")
async def model_status() -> dict[str, Any]:
    status = await _inference_status(force=True)
    return {
        "status": "ready" if _status_is_ready(status) else str(status.get("state") or "unknown").lower(),
        "state": status.get("state"),
        "lifecycle": status.get("lifecycle"),
        "model_loaded": bool(status.get("model_loaded")),
        "tokenizer_loaded": bool(status.get("tokenizer_loaded")),
        "warmup_complete": bool(status.get("warmup_complete")),
        "inference_test": bool(status.get("inference_test")),
        "model": status.get("model"),
        "runtime": status.get("runtime"),
        "quantization": status.get("quantization"),
        "memory": status.get("memory_requirement"),
        "available_ram_mb": status.get("available_ram_mb"),
        "modelLoadMs": status.get("model_load_ms"),
        "warmupMs": status.get("warmup_ms"),
        "coldStartMs": status.get("cold_start_ms"),
        "history": status.get("history", []),
        "resource": status.get("resource"),
        "error": _public_error(status)["message"],
        "errorStage": _public_error(status)["code"],
        "permanentFailure": bool(status.get("permanentFailure")),
        "inferenceService": {"configured": bool(settings.inference_url), "reachable": status.get("reachable", True)},
    }


@app.get("/system/resources")
@app.get("/api/ai/system/resources")
async def system_resources() -> dict[str, Any]:
    """Resources of THIS lightweight process (the inference service reports its own)."""
    return {"role": "orchestrator", **resource_manager.snapshot(), "loadsModel": False}


@app.get("/api/ai/health")
async def ai_health(
    x_ai_internal_token: str | None = Header(default=None),
    deep: bool = False,
) -> dict[str, Any]:
    """Authenticated health used by the API gateway and the frontend status hook."""
    _authorize_internal_request(x_ai_internal_token)
    status = await _inference_status(force=True)
    probe_state = "skipped"
    probe_error: str | None = None
    if deep and _status_is_ready(status):
        try:
            await llm.probe(deep=True)
            probe_state = "ready"
        except Exception as exc:  # noqa: BLE001
            probe_state = "error"
            probe_error = getattr(exc, "error_type", None) or exc.__class__.__name__
    ready = _status_is_ready(status) and probe_state != "error"
    error = _public_error(status)
    return {
        "success": ready,
        "status": str(status.get("state") or "unknown"),
        "modelState": str(status.get("state") or "unknown"),
        "modelReady": ready,
        "serviceAvailable": True,
        "inferenceReachable": status.get("reachable", True),
        "configured": bool(settings.inference_url),
        "provider": settings.llm_provider,
        "selfHosted": True,
        "model": status.get("model"),
        "runtime": status.get("runtime"),
        "quantization": status.get("quantization"),
        "readiness": {
            "modelLoaded": bool(status.get("model_loaded")),
            "warmupComplete": bool(status.get("warmup_complete")),
            "inferenceTest": bool(status.get("inference_test")),
            "inferenceAvailable": ready,
        },
        "errorCode": error["code"],
        "errorMessage": error["message"],
        "resource": status.get("resource"),
        "permanentFailure": bool(status.get("permanentFailure")),
        "probe": probe_state,
        "probeError": probe_error,
        "lastCheckedAt": provider_runtime["lastCheckedAt"],
        "model_status": status,
    }


@app.get("/api/ai/diagnostics")
async def diagnostics(
    x_ai_internal_token: str | None = Header(default=None),
) -> dict[str, Any]:
    _authorize_internal_request(x_ai_internal_token)
    status = await _inference_status(force=True)
    return {
        "success": True,
        "service": "edunova-agent",
        "role": "orchestrator",
        "inferenceUrlConfigured": bool(settings.inference_url),
        "inferenceStatus": status,
        "resources": resource_manager.snapshot(),
        "webSearchConfigured": settings.search_configured,
        "ragEnabled": rag_index is not None,
        "note": "Self-hosted model runs in the persistent inference service; this process never loads weights.",
    }


@app.get("/api/ai/ready")
async def ai_ready(
    x_ai_internal_token: str | None = Header(default=None),
) -> Any:
    """Readiness gate used by the API gateway before forwarding chat."""
    _authorize_internal_request(x_ai_internal_token)
    status = await _inference_status()
    ready = _status_is_ready(status)
    error = _public_error(status)
    payload: dict[str, Any] = {
        "success": ready,
        "modelReady": ready,
        "modelState": str(status.get("state") or "unknown"),
        "lifecycle": status.get("lifecycle") or status.get("state"),
        "runtime": status.get("runtime"),
        "model": status.get("model"),
        "coldStartMs": status.get("cold_start_ms"),
        "lastSelfTest": status.get("last_self_test"),
        "lastError": None if ready else error["message"],
        "errorStage": None if ready else error["code"],
        "resource": status.get("resource"),
        "permanentFailure": bool(status.get("permanentFailure")),
        "modelLoaded": bool(status.get("model_loaded")),
        "warmupComplete": bool(status.get("warmup_complete")),
    }
    if ready:
        return payload
    return JSONResponse(status_code=503, content=payload)


@app.get("/api/ai/metrics")
@app.get("/metrics")
async def ai_metrics(
    x_ai_internal_token: str | None = Header(default=None),
) -> dict[str, Any]:
    """Orchestrator metrics + last inference-service generation numbers."""
    _authorize_internal_request(x_ai_internal_token)
    status = await _inference_status()
    generation = status.get("last_generation") or llm.last_generation_metrics or {}
    metrics: dict[str, Any] = dict(_METRICS)
    metrics["model_load_time_ms"] = status.get("model_load_ms")
    metrics["warmup_time_ms"] = status.get("warmup_ms")
    metrics["cold_start_time_ms"] = status.get("cold_start_ms")
    metrics["first_token_latency_ms"] = _METRICS.get("ema_first_token_latency_ms") or generation.get("firstTokenMs")
    metrics["generation_time_ms"] = generation.get("durationMs")
    metrics["tokens_per_second"] = generation.get("tokensPerSecond")
    metrics["inference_connect_ms"] = llm.last_connect_ms
    metrics["model"] = {"state": status.get("state"), "modelId": status.get("model"), "runtime": status.get("runtime")}
    return {"success": True, "metrics": metrics, "resources": {**_process_resources(), **resource_manager.snapshot()}}


class RagDocumentRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    title: str = Field(min_length=1, max_length=300)
    text: str = Field(min_length=1, max_length=60_000)
    owner_id: str | None = Field(default=None, alias="ownerId", max_length=200)


class RagSearchRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    query: str = Field(min_length=1, max_length=4_000)
    owner_id: str | None = Field(default=None, alias="ownerId", max_length=200)
    k: int = Field(default=5, ge=1, le=10)


def _rag_owner(payload_owner: str | None, header_owner: str | None) -> str:
    """The authenticated server decides the owner — never the model."""
    value = str(header_owner or "").strip()
    if not value or value in {"anonymous", "null", "undefined", "authenticated-user"}:
        return ""
    return value[:200]


@app.get("/api/ai/rag/status")
async def rag_status(
    x_ai_internal_token: str | None = Header(default=None),
) -> dict[str, Any]:
    _authorize_internal_request(x_ai_internal_token)
    if rag_index is None:
        return {"success": False, "enabled": False, "reason": "RAG_ENABLED=false or index failed to start"}
    return {
        "success": True,
        "enabled": True,
        "stats": rag_index.stats,
        "embedderBackend": rag_index.embedder.backend if rag_index.embedder else "none",
        "embeddingModel": rag_index.embedder.model_name if rag_index.embedder else None,
        "ready": rag_index.embedder.is_ready(),
        "lastError": rag_index.embedder._load_error,
    }


@app.post("/api/ai/rag/documents")
async def rag_documents(
    payload: RagDocumentRequest,
    x_user_id: str | None = Header(default=None),
    x_ai_internal_token: str | None = Header(default=None),
) -> dict[str, Any]:
    """Ingest one document into the authenticated owner's semantic index."""
    _authorize_internal_request(x_ai_internal_token)
    owner = _rag_owner(payload.owner_id, x_user_id)
    if rag_index is None:
        return {"success": False, "error": "RAG is not enabled"}
    if not owner:
        return {"success": False, "error": "authenticated owner identity is required"}
    result = await asyncio.to_thread(rag_index.ingest_document, owner, payload.title, payload.text)
    result["success"] = bool(result.get("ingested", 0) > 0)
    result["owner"] = owner
    return result


@app.post("/api/ai/rag/search")
async def rag_search(
    payload: RagSearchRequest,
    x_user_id: str | None = Header(default=None),
    x_ai_internal_token: str | None = Header(default=None),
) -> dict[str, Any]:
    """Semantic retrieval restricted to the authenticated owner's documents."""
    _authorize_internal_request(x_ai_internal_token)
    owner = _rag_owner(payload.owner_id, x_user_id)
    if rag_index is None:
        return {"success": False, "error": "RAG is not enabled", "results": []}
    if not owner:
        return {"success": False, "error": "authenticated owner identity is required", "results": []}
    results = await asyncio.to_thread(rag_index.search, owner, payload.query, payload.k)
    return {"success": True, "query": payload.query[:200], "owner": owner, "results": results, "count": len(results)}


@app.get("/api/ai/diagnose")
async def diagnose(
    x_ai_internal_token: str | None = Header(default=None),
) -> dict[str, Any]:
    """Direct inference diagnostic: orchestrator -> inference service -> model."""
    _authorize_internal_request(x_ai_internal_token)
    started_total = time.monotonic()
    status = await _inference_status(force=True)
    results: dict[str, Any] = {"success": False, "model": status.get("model"), "modelState": status.get("state"),
                               "modelReady": _status_is_ready(status), "connectMs": llm.last_connect_ms,
                               "resource": status.get("resource"), "lastError": status.get("error")}
    if not _status_is_ready(status):
        results["inferenceSkipped"] = True
        results["inferenceSkipReason"] = _public_error(status)["message"]
        results["totalMs"] = int((time.monotonic() - started_total) * 1000)
        return results
    inference_started = time.monotonic()
    try:
        text = await llm.complete_text(system_prompt="You are EduNova AI.", user_prompt="Say hello in one sentence.", max_output_tokens=64)
        results.update({"inferenceResult": "SUCCESS", "responseText": text[:500], "responseLength": len(text),
                        "inferenceMs": int((time.monotonic() - inference_started) * 1000), "generation": llm.last_generation_metrics, "success": True})
    except Exception as exc:  # noqa: BLE001
        results.update({"inferenceResult": "FAILED", "inferenceError": str(exc)[:300], "inferenceCode": getattr(exc, "error_type", None),
                        "inferenceMs": int((time.monotonic() - inference_started) * 1000)})
    results["totalMs"] = int((time.monotonic() - started_total) * 1000)
    return results


def _authorize_internal_request(token: str | None) -> None:
    if settings.ai_require_internal_token and not settings.ai_internal_token:
        raise HTTPException(
            status_code=503,
            detail="AI internal authentication is required but not configured",
        )
    if settings.ai_internal_token and not secrets.compare_digest(
        str(token or ""), settings.ai_internal_token
    ):
        raise HTTPException(status_code=401, detail="AI service authorization failed")


def _ms(since: float) -> int:
    """Milliseconds elapsed since a time.monotonic() mark (for stage timings)."""
    return int((time.monotonic() - since) * 1000)


def _owner(request: ChatRequest) -> str:
    if not request.owner_id:
        raise HTTPException(status_code=401, detail={"code": "AUTH_FAILED", "message": "Authenticated owner is required"})
    return request.owner_id



def _sanitize_provider_message_for_user(text: str, limit: int = 180) -> str:
    import re

    t = str(text or "").strip()
    if not t:
        return ""
    t = re.sub(r"<[^>]*>", " ", t)
    t = re.sub(r"\s+", " ", t).strip()
    t = re.sub(r"sk-[A-Za-z0-9-_]{10,}", "[redacted]", t)
    if len(t) > limit:
        t = t[:limit].rstrip() + "…"
    return t


def _redact(text: str) -> str:
    import re

    text = re.sub(r"(?:https?|mongodb(?:\+srv)?)://\S+", "[endpoint redacted]", str(text))
    text = re.sub(r"(?i)(token|password|api[_-]?key|authorization)\s*[=:]\s*\S+", r"\1=[redacted]", text)
    return text[:600]


def _safe_error(exc: Exception) -> tuple[int, str, str]:
    raw = str(getattr(exc, "error_type", None) or getattr(exc, "code", "") or "")
    aliases = {"model_loading": "MODEL_NOT_READY", "model_unavailable": "MODEL_STARTUP_FAILED",
               "invalid_response": "INVALID_MODEL_OUTPUT", "model_busy": "MODEL_BUSY",
               "provider_error": "INFERENCE_FAILED", "timeout": "UPSTREAM_TIMEOUT"}
    code = aliases.get(raw, raw.upper()) or ("CONFIG_FAILED" if isinstance(exc, LLMConfigurationError) else "INFERENCE_FAILED")
    status = getattr(exc, "status_code", None) or (504 if isinstance(exc, asyncio.TimeoutError) else 503)
    message = _redact(exc) or code
    logger.error("AI_FAILURE code=%s type=%s reason=%s", code, type(exc).__name__, message)
    return status, code, message


async def _ready_gate() -> None:
    """One observational status read. Never starts, reloads or queues on the model.

    The hop itself is timed and logged inside ``_inference_status`` so the
    gateway's readiness probe and the chat path are both covered.
    """
    status = await _inference_status()
    if _status_is_ready(status):
        return
    error = _public_error(status)
    raise LLMResponseError(error["message"] or "Inference service is not ready", status_code=503,
                           error_type=error["code"] or "MODEL_NOT_READY")


async def _execute(
    request: ChatRequest,
    conversation,
    event_callback,
) -> dict[str, Any]:
    """Route to a deterministic fast path or the full autonomous agent loop."""
    decision = intent_router.classify(
        request.message,
        list(conversation.messages),
    )
    common = dict(
        goal=request.message.strip(),
        conversation=list(conversation.messages),
        conversation_id=conversation.id,
        user_id=str(request.owner_id or request.email or "authenticated-user"),
        user_role=str(request.user_role or "student"),
        user_name=str(request.user_name or "Student"),
        user_email=str(request.user_email or request.email or ""),
        application_context={**request.application_context, "requestId": request.request_id},
        event_callback=event_callback,
    )
    from inference.telemetry import begin, finish
    metric = begin(request.request_id, common["user_id"], decision.intent)
    try:
        logger.info("ROUTE_SELECTED request_id=%s intent=%s tools=%s", request.request_id, decision.intent, ",".join(decision.tools))
        if decision.intent != "complex":
            result = await run_fast_path(settings=settings, llm=llm, registry=registry, decision=decision, **common)
        else:
            result = (await agent.run(**common)).public()
        result["performance"] = finish(metric, llm.last_generation_metrics)
        result["requestId"] = request.request_id
        return result
    except Exception as exc:
        finish(metric, failure=getattr(exc, "error_type", type(exc).__name__))
        raise


async def _run_non_stream(request: ChatRequest) -> dict[str, Any]:
    started = time.monotonic()
    queue_started = started
    try:
        await _ready_gate()
    except Exception as exc:
        _bump_metric("error_count")
        raise
    queue_ms = int((time.monotonic() - queue_started) * 1000)
    _record_latency("queue_time_ms", queue_ms)
    logger.info(
        "[EduNova AI] MODEL_READY request_id=%s elapsed_ms=%s queue_ms=%s",
        request.request_id, _ms(started), queue_ms,
    )
    conversation = conversations.get_or_create(request.conversation_id, _owner(request))

    async with conversation.lock:
        result = await _execute(request, conversation, None)
    conversations.append_turn(conversation, request.message.strip(), result.get("message", ""))
    total_ms = _ms(started)
    _record_latency("total_request_latency_ms", total_ms)
    _bump_metric("request_count")
    _bump_metric("success_count")
    logger.info(
        "[EduNova AI] RESPONSE_SENT request_id=%s total_ms=%s inference_host=%s inference_connect_ms=%s",
        request.request_id, total_ms, _inference_host(), llm.last_connect_ms,
    )
    return result


async def _stream(request: ChatRequest):
    started = time.monotonic()
    queue_started = started
    first_token_seen = False
    success_reported = False
    try:
        # One observational readiness read. There is no warm queue: a model
        # that is not READY fails fast with its precise state/code.
        await _ready_gate()
    except Exception as exc:
        status, code, message = _safe_error(exc)
        _bump_metric("error_count")
        yield "data: " + json.dumps(
            {
                "type": "error",
                "success": False,
                "status": status,
                "message": message,
                "error": {"code": code, "message": message},
                "agentStatus": "failed",
                "requestId": request.request_id,
            },
            ensure_ascii=False,
        ) + "\n\n"
        return

    queue_ms = int((time.monotonic() - queue_started) * 1000)
    _record_latency("queue_time_ms", queue_ms)
    logger.info(
        "[EduNova AI] MODEL_READY request_id=%s elapsed_ms=%s queue_ms=%s",
        request.request_id, _ms(started), queue_ms,
    )
    conversation = conversations.get_or_create(request.conversation_id, _owner(request))
    queue: asyncio.Queue[dict[str, Any] | None] = asyncio.Queue()

    async def event_callback(event: dict[str, Any]) -> None:
        await queue.put(event)

    async def runner() -> None:
        try:
            async with conversation.lock:
                result = await _execute(request, conversation, event_callback)
            conversations.append_turn(conversation, request.message.strip(), result.get("message", ""))
            await queue.put({"type": "answer", **result})
        except Exception as exc:
            status, code, message = _safe_error(exc)
            _bump_metric("error_count")
            await queue.put(
                {
                    "type": "error",
                    "success": False,
                    "status": status,
                    "message": message,
                    "error": {"code": code, "message": message},
                    "agentStatus": "failed",
                    "conversationId": conversation.id,
                    "requestId": request.request_id,
                }
            )
        finally:
            await queue.put(None)

    task = asyncio.create_task(runner())
    try:
        while True:
            try:
                event = await asyncio.wait_for(queue.get(), timeout=5)
            except asyncio.TimeoutError:
                yield ": keep-alive\n\n"
                continue
            if event is None:
                break
            # Per-request + global metrics on the live event stream.
            if event.get("type") == "token" and isinstance(event.get("delta"), str):
                if not first_token_seen:
                    first_token_seen = True
                    first_ms = int((time.monotonic() - started) * 1000)
                    _record_latency("first_token_latency_ms", first_ms)
                    logger.info(
                        "[EduNova AI] FIRST_TOKEN request_id=%s first_token_ms=%s",
                        request.request_id, first_ms,
                    )
                _bump_metric("tokens_generated")
            if event.get("type") == "answer":
                success_reported = True
                _bump_metric("request_count")
                _bump_metric("success_count")
                _record_latency("total_request_latency_ms", int((time.monotonic() - started) * 1000))
            event.setdefault("requestId", request.request_id)
            yield "data: " + json.dumps(event, ensure_ascii=False) + "\n\n"
    finally:
        if not success_reported and not first_token_seen:
            # Request counted as failed only if nothing useful was delivered.
            pass
        if not task.done():
            task.cancel()
            try:
                await asyncio.wait_for(asyncio.shield(task), timeout=2)
            except (asyncio.TimeoutError, asyncio.CancelledError, Exception):
                pass


@app.post("/api/ai/chat")
async def chat(
    payload: ChatRequest,
    request: Request,
    x_ai_internal_token: str | None = Header(default=None),
):
    request_started = time.monotonic()
    request_id = str(request.headers.get("x-request-id") or _new_request_id())[:80]
    payload.request_id = request_id
    logger.info(
        "[EduNova AI] REQUEST_START request_id=%s stream=%s message_chars=%s",
        request_id, payload.stream, len(payload.message),
    )
    _authorize_internal_request(x_ai_internal_token)
    if not payload.owner_id:
        raise HTTPException(status_code=401, detail={"code": "AUTH_FAILED", "message": "Authenticated owner is required"})
    logger.info("[EduNova AI] AUTH_COMPLETE request_id=%s elapsed_ms=%s", request_id, _ms(request_started))
    clean_message = payload.message.strip()
    if not clean_message:
        _bump_metric("error_count")
        raise HTTPException(status_code=422, detail="message cannot be blank")
    payload.message = clean_message

    # Response time is a performance metric, never a generation limit. The
    # self-hosted model runs to EOS (or its token ceiling) while SSE keep-alives
    # and real token events keep the connection active.

    wants_stream = payload.stream or "text/event-stream" in request.headers.get("accept", "")
    if wants_stream:
        return StreamingResponse(
            _stream(payload),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache, no-transform",
                "X-Accel-Buffering": "no",
                "Connection": "keep-alive",
                "X-Request-Id": request_id,
            },
        )
    try:
        return await _run_non_stream(payload)
    except Exception as exc:
        status, code, message = _safe_error(exc)
        raise HTTPException(
            status_code=status,
            detail={"code": code, "message": message, "requestId": request_id},
        ) from exc


@app.post("/api/ai/query")
@app.post("/ai/query")
async def legacy_query(
    payload: ChatRequest,
    x_ai_internal_token: str | None = Header(default=None),
):
    _authorize_internal_request(x_ai_internal_token)
    payload.stream = False
    try:
        return await _run_non_stream(payload)
    except Exception as exc:
        status, code, message = _safe_error(exc)
        raise HTTPException(status_code=status, detail={"code": code, "message": message}) from exc
