"""EduNova PERSISTENT AI INFERENCE SERVICE (Layer B).

This process — and ONLY this process — owns the self-hosted model:

    start -> resource check -> runtime check -> model validation -> model load
          -> warmup ("What is 2 + 2?") -> real inference test -> READY -> serve

It exposes a small authenticated HTTP/SSE API consumed by the lightweight
orchestrator (``main.py``) through ``agent/remote_llm.py``:

    GET  /health            liveness (process alive; never claims readiness)
    GET  /ready             200 only when real inference is possible
    GET  /model/status      MODEL_NOT_READY | MODEL_LOADING | MODEL_READY | MODEL_FAILED
    GET  /system/resources  ResourceManager snapshot
    GET  /metrics           load/warmup/first-token/tokens-per-second
    POST /generate          one completion (JSON)
    POST /generate/stream   real token-by-token SSE
    POST /embeddings        PyTorch sentence embeddings for RAG (optional;
                            NOT loaded when RAG_ENABLED=false, e.g. the
                            Render Free 512 MiB runtime)

Requests never download, load or warm a model. If the container cannot hold
the model the service reports MODEL_RESOURCE_INSUFFICIENT with
required_mb / available_mb / recommended_mb and stays in MODEL_FAILED — it
does not loop in WARMING/PREPARING. The resource math in
``inference/resources.py`` is sized so a genuine fit (SmolLM2-135M Q4_K_M,
ctx 2048, 1 thread, embeddings off on a 512 MiB instance) PASSES, while a
configuration that would OOM fails fast with numbers.

Run:  uvicorn inference_server:app --host 0.0.0.0 --port $PORT --workers 1
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

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, ConfigDict, Field

try:
    from dotenv import load_dotenv

    load_dotenv(Path(__file__).resolve().parent / ".env")
except ImportError:
    pass

from agent.llm import LLMResponseError
from config import load_settings
from inference.manager import FAILURES, ModelManager, model_requirement, public_state, safe_error
from inference.resources import ResourceManager

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO").upper(),
                    format="%(asctime)s %(levelname)s %(name)s %(message)s")
logger = logging.getLogger("edunova.inference")
settings = load_settings()
SERVICE_VERSION = "6.0.0"

manager = ModelManager(settings)
resource_manager = ResourceManager(settings.local_model_dir)
_METRICS: dict[str, Any] = {"request_count": 0, "success_count": 0, "error_count": 0, "tokens_generated": 0,
                            "first_token_latency_ms": None, "tokens_per_second": None, "generation_time_ms": None,
                            "started_at": time.time()}

# Embeddings (PyTorch) are optional and lazy: they load AFTER the LLM is READY
# and only when the container has headroom. A failure here never affects chat.
_embedder: Any = None
_embedder_error: str | None = None


def _authorize(token: str | None) -> None:
    if settings.ai_require_internal_token and not settings.ai_internal_token:
        raise HTTPException(status_code=503, detail={"code": "AUTH_FAILED", "message": "AI internal authentication is required but not configured"})
    if settings.ai_internal_token and not secrets.compare_digest(str(token or ""), settings.ai_internal_token):
        raise HTTPException(status_code=401, detail={"code": "AUTH_FAILED", "message": "Inference service authorization failed"})


async def _prepare_embeddings() -> None:
    global _embedder, _embedder_error
    if not settings.rag_enabled:
        return
    await manager._ready_event.wait()
    if not manager.is_ready():
        return
    try:
        from inference.rag import Embedder
        embedder = Embedder(settings.rag_embedding_model or None)
        await asyncio.wait_for(asyncio.to_thread(embedder.load), timeout=180)
        _embedder = embedder
        logger.info("EMBEDDINGS_READY backend=%s model=%s", embedder.backend, embedder.model_name)
    except Exception as exc:  # noqa: BLE001 — surfaced on /model/status, never hidden
        _embedder_error = f"{type(exc).__name__}: {safe_error(exc)}"[:300]
        logger.error("EMBEDDINGS_UNAVAILABLE reason=%s", _embedder_error)


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("INFERENCE_SERVICE_START model=%s ctx=%s threads=%s dir=%s resources=%s",
                settings.local_model_id, settings.local_model_ctx_size, settings.local_model_threads,
                settings.local_model_dir, json.dumps(resource_manager.snapshot()))
    manager.ensure_loading()
    task = asyncio.create_task(_prepare_embeddings())
    try:
        yield
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        await manager.close()


app = FastAPI(title="EduNova AI Inference Service", version=SERVICE_VERSION, lifespan=lifespan,
              description="Persistent self-hosted LLM (llama.cpp/GGUF; Render-Free sized). "
                          "PyTorch embeddings only when RAG_ENABLED=true. Internal, token-authenticated.")


class GenerateRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    system_prompt: str = Field(min_length=1, max_length=40_000)
    user_prompt: str = Field(min_length=1, max_length=120_000)
    max_tokens: int = Field(default=512, ge=1, le=8192)
    temperature: float | None = Field(default=None, ge=0.0, le=2.0)
    json_schema: dict[str, Any] | None = None
    stream: bool = False


class EmbedRequest(BaseModel):
    texts: list[str] = Field(min_length=1, max_length=64)


def _status_payload() -> dict[str, Any]:
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
        "model": snap.get("modelId"),
        "runtime": "llama_cpp",
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
        "available_ram_mb": resource_manager.snapshot().get("ram_available_mb"),
        "embeddings": {"ready": _embedder is not None,
                       "disabled": not settings.rag_enabled,
                       "backend": getattr(_embedder, "backend", None),
                       "model": getattr(_embedder, "model_name", None), "error": _embedder_error},
        "history": snap.get("history", []),
        "permanentFailure": manager.phase in FAILURES,
        "error": None if ready else (snap.get("lastError") or None),
        "errorStage": None if ready else (snap.get("errorDetail") or None),
    }
    if manager.phase == "MODEL_RESOURCE_INSUFFICIENT" and isinstance(manager.error_report, dict):
        payload["resource"] = {k: manager.error_report.get(k) for k in ("error", "required_mb", "available_mb", "recommended_mb", "breakdown")}
    return payload


@app.get("/")
async def root() -> dict[str, Any]:
    return {"service": "edunova-inference", "version": SERVICE_VERSION, "state": public_state(manager.phase)}


@app.get("/health")
async def health() -> dict[str, Any]:
    """Process liveness. Model readiness is reported next to it, never implied."""
    return {"status": "live", "service": "edunova-inference", "version": SERVICE_VERSION,
            "state": public_state(manager.phase), "lifecycle": manager.phase, "modelReady": manager.is_ready(),
            "permanentFailure": manager.phase in FAILURES, "error": manager.last_error or None}


@app.get("/ready")
async def ready() -> Any:
    if manager.is_ready():
        return {"ready": True, "state": "MODEL_READY", "model_loaded": True, "warmup_complete": True,
                "inference_test": True, "available_ram_mb": resource_manager.snapshot().get("ram_available_mb")}
    payload = {"ready": False, "state": public_state(manager.phase), "lifecycle": manager.phase,
               "error": manager.last_error or None, "errorStage": manager.error_detail or None}
    if manager.phase == "MODEL_RESOURCE_INSUFFICIENT" and isinstance(manager.error_report, dict):
        payload.update({k: manager.error_report.get(k) for k in ("required_mb", "available_mb", "recommended_mb")})
    return JSONResponse(status_code=503, content=payload)


@app.get("/model/status")
async def model_status(x_ai_internal_token: str | None = Header(default=None)) -> Any:
    _authorize(x_ai_internal_token)
    return _status_payload()


@app.get("/system/resources")
async def system_resources(x_ai_internal_token: str | None = Header(default=None)) -> dict[str, Any]:
    _authorize(x_ai_internal_token)
    snapshot = resource_manager.snapshot()
    try:
        from agent.local_llm import LocalModelManager
        requirement = model_requirement(settings, LocalModelManager(settings).model_path)
    except Exception as exc:  # noqa: BLE001
        requirement = {"error": safe_error(exc)}
    return {**snapshot, "model_requirement": requirement,
            "fits": bool(snapshot.get("ram_limit_mb") or snapshot.get("ram_total_mb") or 0) and
                    int(snapshot.get("ram_limit_mb") or snapshot.get("ram_total_mb") or 0) >= int(requirement.get("required_mb", 0) or 0)}


@app.get("/metrics")
async def metrics(x_ai_internal_token: str | None = Header(default=None)) -> dict[str, Any]:
    _authorize(x_ai_internal_token)
    snap = manager.snapshot()
    generation = snap.get("lastGeneration") or {}
    return {"success": True, "metrics": {**_METRICS, "model_load_time_ms": snap.get("modelLoadMs"),
            "warmup_time_ms": snap.get("warmupMs"), "cold_start_time_ms": snap.get("coldStartMs"),
            "last_first_token_ms": generation.get("firstTokenMs"), "last_tokens_per_second": generation.get("tokensPerSecond"),
            "uptime_seconds": round(time.time() - _METRICS["started_at"]), "state": public_state(manager.phase)},
            "resources": resource_manager.snapshot()}


def _http_error(exc: Exception) -> HTTPException:
    code = str(getattr(exc, "error_type", "") or "INFERENCE_FAILED")
    status = int(getattr(exc, "status_code", None) or 503)
    detail: dict[str, Any] = {"code": code, "message": safe_error(exc)}
    if manager.phase == "MODEL_RESOURCE_INSUFFICIENT" and isinstance(manager.error_report, dict):
        detail.update({k: manager.error_report.get(k) for k in ("required_mb", "available_mb", "recommended_mb")})
    return HTTPException(status_code=status, detail=detail)


def _record(metrics: dict[str, Any] | None, ok: bool) -> None:
    _METRICS["request_count"] += 1
    _METRICS["success_count" if ok else "error_count"] += 1
    if metrics:
        _METRICS["tokens_generated"] += int(metrics.get("tokens") or 0)
        _METRICS["first_token_latency_ms"] = metrics.get("firstTokenMs")
        _METRICS["tokens_per_second"] = metrics.get("tokensPerSecond")
        _METRICS["generation_time_ms"] = metrics.get("durationMs")


@app.post("/generate")
async def generate(payload: GenerateRequest, x_ai_internal_token: str | None = Header(default=None)) -> dict[str, Any]:
    _authorize(x_ai_internal_token)
    started = time.monotonic()
    try:
        text = await manager.generate(system_prompt=payload.system_prompt, user_prompt=payload.user_prompt,
                                      max_tokens=payload.max_tokens, temperature=payload.temperature,
                                      json_schema=payload.json_schema)
    except Exception as exc:  # noqa: BLE001
        _record(None, False)
        raise _http_error(exc) from exc
    _record(manager.last_generation_metrics, True)
    return {"text": text, "metrics": manager.last_generation_metrics, "total_ms": int((time.monotonic() - started) * 1000)}


@app.post("/generate/stream")
async def generate_stream(payload: GenerateRequest, request: Request, x_ai_internal_token: str | None = Header(default=None)):
    _authorize(x_ai_internal_token)
    try:
        await manager.wait_ready()
    except Exception as exc:  # noqa: BLE001
        raise _http_error(exc) from exc

    loop = asyncio.get_running_loop()
    queue: asyncio.Queue[Any] = asyncio.Queue()

    def on_token(piece: str) -> None:
        loop.call_soon_threadsafe(queue.put_nowait, ("token", piece))

    async def runner() -> None:
        try:
            text = await manager.generate(system_prompt=payload.system_prompt, user_prompt=payload.user_prompt,
                                          max_tokens=payload.max_tokens, temperature=payload.temperature,
                                          json_schema=payload.json_schema, on_token=on_token)
            await queue.put(("done", {"type": "done", "text": text, "metrics": manager.last_generation_metrics}))
            _record(manager.last_generation_metrics, True)
        except Exception as exc:  # noqa: BLE001
            _record(manager.last_generation_metrics, False)
            await queue.put(("error", {"type": "error", "status": int(getattr(exc, "status_code", None) or 502),
                                       "message": safe_error(exc),
                                       "error": {"code": str(getattr(exc, "error_type", "") or "INFERENCE_FAILED"), "message": safe_error(exc)}}))
        finally:
            await queue.put((None, None))

    task = asyncio.create_task(runner())

    async def events():
        started = time.monotonic()
        first = None
        try:
            while True:
                try:
                    kind, item = await asyncio.wait_for(queue.get(), timeout=5)
                except asyncio.TimeoutError:
                    yield ": keep-alive\n\n"
                    continue
                if kind is None:
                    break
                if kind == "token":
                    if first is None:
                        first = int((time.monotonic() - started) * 1000)
                    yield "data: " + json.dumps({"type": "token", "delta": item}, ensure_ascii=False) + "\n\n"
                else:
                    if kind == "done":
                        item["first_token_ms"] = first
                    yield "data: " + json.dumps(item, ensure_ascii=False) + "\n\n"
        finally:
            if not task.done():
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)

    return StreamingResponse(events(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no", "Connection": "keep-alive"})


@app.post("/embeddings")
async def embeddings(payload: EmbedRequest, x_ai_internal_token: str | None = Header(default=None)) -> dict[str, Any]:
    _authorize(x_ai_internal_token)
    if _embedder is None:
        raise HTTPException(status_code=503, detail={"code": "EMBEDDINGS_UNAVAILABLE",
                                                     "message": _embedder_error or (
                                                         "Embedding model is not loaded (RAG_ENABLED=false on this runtime; "
                                                         "enable it only on an instance with memory headroom)"
                                                         if not settings.rag_enabled else "Embedding model is not loaded")})
    started = time.monotonic()
    try:
        vectors = await asyncio.to_thread(_embedder.embed, [t[:4000] for t in payload.texts])
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail={"code": "EMBEDDINGS_FAILED", "message": safe_error(exc)}) from exc
    return {"vectors": vectors, "backend": _embedder.backend, "fingerprint": _embedder.fingerprint,
            "duration_ms": int((time.monotonic() - started) * 1000)}
