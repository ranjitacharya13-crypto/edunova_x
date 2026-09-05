"""FastAPI entrypoint for the EduNova unified autonomous AI agent."""

from __future__ import annotations

import asyncio
import json
import logging
import os
from pathlib import Path
import secrets
from typing import Any
from datetime import datetime, timezone
from urllib.parse import urlsplit

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict, Field

# Local development convenience only. Production injects environment variables.
try:
    from dotenv import load_dotenv

    load_dotenv(Path(__file__).resolve().parent / ".env")
    load_dotenv(Path(__file__).resolve().parents[1] / "server" / ".env")
except ImportError:
    pass

from agent.engine import AgentEngine
from agent.llm import LLMConfigurationError, LLMResponseError, OpenAICompatibleLLM
from agent.memory import ConversationStore
from agent.tools import ToolRegistry, build_all_tools
from config import load_settings

logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
logger = logging.getLogger("edunova.api")
settings = load_settings()


# --- Safe startup diagnostics (no secrets) ---
def _log_startup_diagnostics() -> None:
    diag = settings.llm_safe_diagnostics()
    host = diag.get("llm_base_url_host") or "unknown"
    is_prod = os.getenv("NODE_ENV", "").lower() == "production" or os.getenv("ENV", "").lower() == "production"
    localhost_warning = ""
    if diag.get("llm_base_url_is_localhost") and is_prod:
        localhost_warning = " [WARNING: base_url points to localhost in production]"
    logger.info(
        "AI_SERVICE_STARTUP llm_configured=%s provider=%s provider_host=%s model=%s api_key_present=%s search_configured=%s internal_auth_required=%s%s",
        diag.get("llm_configured"),
        settings.llm_provider,
        host,
        diag.get("llm_model") or "none",
        diag.get("llm_api_key_present"),
        settings.search_configured,
        settings.ai_require_internal_token,
        localhost_warning,
    )
    if not settings.llm_configured:
        missing: list[str] = []
        if not settings.llm_api_key:
            missing.append("LLM_API_KEY")
        if not settings.llm_model:
            missing.append("LLM_MODEL")
        if not settings.llm_base_url:
            missing.append("LLM_BASE_URL")
        logger.warning(
            "AI_LLM_CONFIGURATION_INCOMPLETE missing=%s llm_key_present=%s llm_model_present=%s llm_base_url_present=%s "
            "hint=Set LLM_PROVIDER, LLM_API_KEY, LLM_MODEL, LLM_BASE_URL on the ai_engine service (canonical variables only)",
            ",".join(missing) if missing else "unknown",
            diag.get("llm_api_key_present"),
            diag.get("llm_model_present"),
            diag.get("llm_base_url_present"),
        )
    else:
        logger.info(
            "AI_PROVIDER_STARTUP_OK provider_host=%s model=%s timeout=%s json_mode=%s",
            host,
            settings.llm_model,
            settings.llm_timeout_seconds,
            settings.llm_json_mode,
        )


_log_startup_diagnostics()

registry = ToolRegistry(
    allowed_permissions={"READ_INTERNAL", "WRITE_INTERNAL", "READ_EXTERNAL", "UTILITY"}
)
for definition in build_all_tools(settings):
    registry.register(definition)

llm = OpenAICompatibleLLM(settings)
agent = AgentEngine(settings, llm, registry)
provider_runtime = {
    "state": "ready" if settings.llm_configured else "missing_config",
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


conversations = ConversationStore(
    max_turns=settings.conversation_max_turns,
    ttl_seconds=settings.conversation_ttl_seconds,
)

app = FastAPI(
    title="EduNova AI Agent",
    version="2.1.0",
    description="Unified data-aware learning and research agent combining internal database, external data, conversation context, and LLM knowledge.",
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


@app.get("/")
async def root() -> dict[str, Any]:
    return {
        "success": True,
        "service": "edunova-agent",
        "version": "2.1.0",
        "architecture": "unified-data-aware-agent",
        "endpoint": "POST /api/ai/chat",
    }


@app.get("/health")
async def health() -> dict[str, Any]:
    diag = settings.llm_safe_diagnostics()
    return {
        "status": "live",
        "service": "edunova-agent",
        "providerState": provider_runtime["state"],
        "llmConfigured": settings.llm_configured,
        "llmDiagnostics": diag,
        "webSearchConfigured": settings.search_configured,
        "internalAuthConfigured": bool(settings.ai_internal_token),
        "internalAuthRequired": settings.ai_require_internal_token,
        "tools": [spec["name"] for spec in registry.specs()],
        "limits": {
            "maxIterations": settings.max_agent_iterations,
            "maxToolCalls": settings.max_tool_calls,
            "maxRuntimeSeconds": settings.max_agent_runtime_seconds,
        },
    }


@app.get("/api/ai/health")
async def ai_health(
    x_ai_internal_token: str | None = Header(default=None),
) -> dict[str, Any]:
    _authorize_internal_request(x_ai_internal_token)
    try:
        await llm.probe()
        _set_provider_state("ready", 200, None)
    except Exception as exc:
        _safe_error(exc)
    return {
        "success": provider_runtime["state"] == "ready",
        "status": provider_runtime["state"],
        "serviceAvailable": True,
        "configured": settings.llm_configured,
        "provider": settings.llm_provider,
        "model": settings.llm_model,
        "apiKeyPresent": bool(settings.llm_api_key),
        "configurationError": settings.llm_configuration_error,
        "lastCheckedAt": provider_runtime["lastCheckedAt"],
        "lastProviderHttpStatus": provider_runtime["lastHttpStatus"],
        "lastProviderErrorType": provider_runtime["lastErrorType"],
    }


@app.get("/api/ai/diagnostics")
async def diagnostics(
    x_ai_internal_token: str | None = Header(default=None),
) -> dict[str, Any]:
    _authorize_internal_request(x_ai_internal_token)
    diag = settings.llm_safe_diagnostics()
    host = diag.get("llm_base_url_host") or "unknown"
    base_url_ok = bool(host and host != "unknown" and "." in host)
    return {
        "success": True,
        "service": "edunova-agent",
        "llm": diag,
        "baseUrlResolvable": base_url_ok,
        "note": "LLM credentials are never exposed; set LLM_API_KEY, LLM_MODEL, LLM_BASE_URL on this service",
    }


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


def _owner(request: ChatRequest) -> str:
    return str(request.owner_id or request.email or "anonymous")[:200]


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


def _safe_error(exc: Exception) -> tuple[int, str, str]:
    if isinstance(exc, asyncio.TimeoutError):
        _set_provider_state("provider_unavailable", 504, "timeout")
        return 504, "LLM_TIMEOUT", "EduNova AI took too long to respond. Please try again."
    if isinstance(exc, LLMConfigurationError):
        _set_provider_state("missing_config", None, settings.llm_configuration_error or "missing_config")
        logger.error("AI_PROVIDER_CONFIGURATION_ERROR provider=%s model=%s host=%s reason=%s", settings.llm_provider, settings.llm_model, urlsplit(settings.llm_base_url).hostname if settings.llm_base_url else "none", settings.llm_configuration_error)
        return 503, "LLM_MISSING_CONFIG", "EduNova AI is not configured correctly."
    if isinstance(exc, LLMResponseError):
        status = getattr(exc, "status_code", None)
        error_type = str(getattr(exc, "error_type", "") or "provider_error")
        logger.error("AI_PROVIDER_ERROR provider=%s model=%s host=%s status=%s type=%s", settings.llm_provider, settings.llm_model, urlsplit(settings.llm_base_url).hostname if settings.llm_base_url else "none", status, error_type)
        if status in (401, 403):
            _set_provider_state("authentication_failed", status, error_type)
            return 503, "LLM_AUTHENTICATION_FAILED", "EduNova AI provider authentication is not configured correctly."
        if status == 404 or error_type in {"not_found", "model_not_found"}:
            _set_provider_state("model_not_found", status, error_type)
            return 503, "LLM_MODEL_NOT_FOUND", "The configured AI model is unavailable."
        if status == 429 or error_type == "rate_limit":
            _set_provider_state("rate_limited", 429, error_type)
            return 429, "LLM_RATE_LIMITED", "EduNova AI is rate limited. Please try again shortly."
        if status in (408, 504) or error_type == "timeout":
            _set_provider_state("provider_unavailable", status or 504, error_type)
            return 504, "LLM_TIMEOUT", "EduNova AI took too long to respond. Please try again."
        if status == 400:
            _set_provider_state("provider_unavailable", status, error_type)
            return 502, "LLM_INVALID_REQUEST", "The AI provider rejected the request."
        _set_provider_state("provider_unavailable", status, error_type)
        return 502, "LLM_PROVIDER_UNAVAILABLE", "The AI model provider is temporarily unavailable. Please try again."
    logger.exception("Agent request failed")
    return 500, "LLM_INTERNAL_ERROR", "EduNova AI could not complete this request. Please try again."


async def _run_non_stream(request: ChatRequest) -> dict[str, Any]:
    conversation = conversations.get_or_create(request.conversation_id, _owner(request))
    result = await asyncio.wait_for(
        agent.run(
            goal=request.message.strip(),
            conversation=list(conversation.messages),
            conversation_id=conversation.id,
            user_id=str(request.owner_id or request.email or "authenticated-user"),
            user_role=str(request.user_role or "student"),
            user_name=str(request.user_name or "Student"),
            user_email=str(request.user_email or request.email or ""),
            application_context=request.application_context,
        ),
        timeout=settings.max_agent_runtime_seconds,
    )
    conversations.append_turn(conversation, request.message.strip(), result.message)
    _set_provider_state("ready", 200, None)
    return result.public()


async def _stream(request: ChatRequest):
    conversation = conversations.get_or_create(request.conversation_id, _owner(request))
    queue: asyncio.Queue[dict[str, Any] | None] = asyncio.Queue()

    async def event_callback(event: dict[str, Any]) -> None:
        await queue.put(event)

    async def runner() -> None:
        try:
            result = await asyncio.wait_for(
                agent.run(
                    goal=request.message.strip(),
                    conversation=list(conversation.messages),
                    conversation_id=conversation.id,
                    user_id=str(request.owner_id or request.email or "authenticated-user"),
                    user_role=str(request.user_role or "student"),
                    user_name=str(request.user_name or "Student"),
                    user_email=str(request.user_email or request.email or ""),
                    application_context=request.application_context,
                    event_callback=event_callback,
                ),
                timeout=settings.max_agent_runtime_seconds,
            )
            conversations.append_turn(conversation, request.message.strip(), result.message)
            _set_provider_state("ready", 200, None)
            await queue.put({"type": "answer", **result.public()})
        except Exception as exc:
            status, code, message = _safe_error(exc)
            await queue.put(
                {
                    "type": "error",
                    "success": False,
                    "status": status,
                    "message": message,
                    "error": {"code": code, "message": message},
                    "agentStatus": "failed",
                    "conversationId": conversation.id,
                }
            )
        finally:
            await queue.put(None)

    task = asyncio.create_task(runner())
    try:
        while True:
            try:
                event = await asyncio.wait_for(queue.get(), timeout=15)
            except asyncio.TimeoutError:
                yield ": keep-alive\n\n"
                continue
            if event is None:
                break
            yield "data: " + json.dumps(event, ensure_ascii=False) + "\n\n"
    finally:
        if not task.done():
            task.cancel()


@app.post("/api/ai/chat")
async def chat(
    payload: ChatRequest,
    request: Request,
    x_ai_internal_token: str | None = Header(default=None),
):
    _authorize_internal_request(x_ai_internal_token)
    clean_message = payload.message.strip()
    if not clean_message:
        raise HTTPException(status_code=422, detail="message cannot be blank")
    payload.message = clean_message

    wants_stream = payload.stream or "text/event-stream" in request.headers.get("accept", "")
    if wants_stream:
        return StreamingResponse(
            _stream(payload),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache, no-transform",
                "X-Accel-Buffering": "no",
                "Connection": "keep-alive",
            },
        )
    try:
        return await _run_non_stream(payload)
    except Exception as exc:
        status, code, message = _safe_error(exc)
        raise HTTPException(status_code=status, detail={"code": code, "message": message}) from exc


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
