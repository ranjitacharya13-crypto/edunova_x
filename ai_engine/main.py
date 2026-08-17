"""FastAPI entrypoint for the EduNova autonomous AI agent."""

from __future__ import annotations

import asyncio
import json
import logging
import os
from pathlib import Path
import secrets
from typing import Any

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
from agent.tools import ToolRegistry, build_web_tools
from config import load_settings

logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
logger = logging.getLogger("edunova.api")
settings = load_settings()

registry = ToolRegistry(allowed_permissions={"READ_EXTERNAL"})
for definition in build_web_tools(settings):
    registry.register(definition)
llm = OpenAICompatibleLLM(settings)
agent = AgentEngine(settings, llm, registry)
conversations = ConversationStore(
    max_turns=settings.conversation_max_turns,
    ttl_seconds=settings.conversation_ttl_seconds,
)

app = FastAPI(
    title="EduNova AI Agent",
    version="2.0.0",
    description="Goal-oriented learning and research agent with permissioned tools.",
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
    email: str | None = Field(default=None, max_length=320)  # Legacy client compatibility.
    stream: bool = False


@app.get("/")
async def root() -> dict[str, Any]:
    return {
        "success": True,
        "service": "edunova-agent",
        "version": "2.0.0",
        "architecture": "autonomous-agent-loop",
        "endpoint": "POST /api/ai/chat",
    }


@app.get("/health")
async def health() -> dict[str, Any]:
    return {
        "status": "live",
        "service": "edunova-agent",
        "llmConfigured": settings.llm_configured,
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


def _safe_error(exc: Exception) -> tuple[int, str]:
    if isinstance(exc, asyncio.TimeoutError):
        return 504, "EduNova AI reached its runtime safety limit. Please narrow the request and try again."
    if isinstance(exc, LLMConfigurationError):
        return 503, str(exc)
    if isinstance(exc, LLMResponseError):
        return 502, "The AI model provider is temporarily unavailable. Please try again."
    logger.exception("Agent request failed")
    return 500, "EduNova AI could not complete this request. Please try again."


async def _run_non_stream(request: ChatRequest) -> dict[str, Any]:
    conversation = conversations.get_or_create(request.conversation_id, _owner(request))
    result = await asyncio.wait_for(
        agent.run(
            goal=request.message.strip(),
            conversation=list(conversation.messages),
            conversation_id=conversation.id,
        ),
        timeout=settings.max_agent_runtime_seconds,
    )
    conversations.append_turn(conversation, request.message.strip(), result.message)
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
                    event_callback=event_callback,
                ),
                timeout=settings.max_agent_runtime_seconds,
            )
            conversations.append_turn(conversation, request.message.strip(), result.message)
            await queue.put({"type": "answer", **result.public()})
        except Exception as exc:  # The HTTP stream is already open; report a safe SSE error.
            status, message = _safe_error(exc)
            await queue.put(
                {
                    "type": "error",
                    "success": False,
                    "status": status,
                    "message": message,
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
                # Keeps proxies from closing the stream during a long provider call.
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
        status, message = _safe_error(exc)
        raise HTTPException(status_code=status, detail=message) from exc


# Backward-compatible endpoint for older deployed Node clients. It invokes the
# same agent engine; there is no separate fixed timetable workflow.
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
        status, message = _safe_error(exc)
        raise HTTPException(status_code=status, detail=message) from exc
