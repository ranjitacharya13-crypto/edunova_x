"""Self-hosted local LLM runtime for EduNova AI (llama.cpp, GGUF, CPU).

This module replaces external hosted LLM APIs with a quantized open-source
model that runs **inside the Python process** of the AI service:

- The model is downloaded once per container (Render free tier has no
  persistent disk) in a background task, verified, then loaded with mmap.
- ``LocalLlamaLLM`` implements the same interface the AgentEngine's Planner
  already uses (``probe()`` / ``complete_json()``) plus ``complete_text()``
  used by the deterministic fast paths — no architecture replacement.
- JSON output is grammar-constrained (GGUF json-schema -> llama.cpp grammar)
  so a 0.5B-class model reliably returns parseable decisions on the first try.
- Generation is single-flight: llama.cpp's KV cache is reused across calls
  (longest-prefix reuse), which only works safely if one generation runs at a
  time in a given process. That also matches the free-tier CPU reality.

Failure contract (no silent fake answers):
- model not ready yet   -> LLMResponseError(status=503, error_type="model_loading")
- model failed to load  -> LLMResponseError(status=503, error_type="model_unavailable")
- llama-cpp missing     -> LLMConfigurationError with installation guidance

The weights file never enters Git; it is fetched at runtime from
``LOCAL_MODEL_URL`` or from the HuggingFace ``resolve/main`` URL of
``LOCAL_MODEL_REPO`` / ``LOCAL_MODEL_FILE``.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
from pathlib import Path
import re
import time
from typing import Any
from urllib.parse import urlsplit

import httpx

from config import Settings
from .llm import LLMConfigurationError, LLMResponseError, parse_json_object

logger = logging.getLogger("edunova.llm.local")

_USER_AGENT = "EduNovaLocalModel/1.0 (+self-hosted)"
_FILENAME_SAFE = re.compile(r"[^A-Za-z0-9._-]+")
_MIN_MODEL_BYTES = 10 * 1024 * 1024  # a real GGUF is never smaller than 10MB

# Grammar-constrained JSON shape used for planner decisions. Kept permissive
# (toolInput is a free-form object) so a small model stays reliable.
DECISION_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "action": {"type": "string", "enum": ["tool", "final"]},
        "toolName": {"type": "string"},
        "toolInput": {"type": "object"},
        "answer": {"type": "string"},
        "status": {"type": "string"},
        "stateUpdate": {
            "type": "object",
            "properties": {
                "goalType": {"type": "string"},
                "currentUnderstanding": {"type": "string"},
                "knownFacts": {"type": "array", "items": {"type": "string"}},
                "unknowns": {"type": "array", "items": {"type": "string"}},
                "assumptions": {"type": "array", "items": {"type": "string"}},
                "plan": {"type": "array", "items": {"type": "string"}},
                "completedObjectives": {"type": "array", "items": {"type": "string"}},
                "pendingObjectives": {"type": "array", "items": {"type": "string"}},
                "confidence": {"type": "string", "enum": ["LOW", "MEDIUM", "HIGH"]},
            },
            "additionalProperties": True,
        },
    },
    "required": ["action"],
    "additionalProperties": True,
}

# ChatML is the template Qwen2.5-Instruct models are trained with; the others
# are provided so operators can point LOCAL_MODEL_* at a different GGUF.
_CHAT_TEMPLATES: dict[str, dict[str, Any]] = {
    "chatml": {
        "prompt": "<|im_start|>system\n{system}<|im_end|>\n<|im_start|>user\n{user}<|im_end|>\n<|im_start|>assistant\n",
        "stops": ["<|im_end|>", "<|im_start|>"],
    },
    "llama-3": {
        "prompt": "<|begin_of_text|><|start_header_id|>system<|end_header_id|>\n\n{system}<|eot_id|><|start_header_id|>user<|end_header_id|>\n\n{user}<|eot_id|><|start_header_id|>assistant<|end_header_id|>\n\n",
        "stops": ["<|eot_id|>", "<|end_of_text|>", "<|start_header_id|>"],
    },
    "mistral": {
        "prompt": "<s>[INST] {system}\n\n{user} [/INST]",
        "stops": ["</s>", "[INST]"],
    },
    "gemma": {
        "prompt": "<start_of_turn>user\n{system}\n\n{user}<end_of_turn>\n<start_of_turn>model\n",
        "stops": ["<end_of_turn>", "<start_of_turn>"],
    },
}


def _safe_filename(name: str) -> str:
    cleaned = _FILENAME_SAFE.sub("", str(name or "").strip())
    cleaned = cleaned.lstrip(".")  # never a hidden/traversal-style name
    cleaned = re.sub(r"\.{2,}", ".", cleaned)  # collapse remaining dot runs
    if not cleaned or not cleaned.lower().endswith(".gguf"):
        cleaned = "edunova-model.gguf"
    return cleaned[:200]


class LocalModelManager:
    """Owns download + loading lifecycle of the GGUF model file."""

    def __init__(self, settings: Settings):
        self.settings = settings
        self.state = "not_started"  # not_started|downloading|loading|ready|error
        self.last_error: str = ""
        self.error_detail: str = ""
        self.started_at: float | None = None
        self.ready_at: float | None = None
        self.downloaded_bytes: int = 0
        self.file_size_bytes: int = 0
        self._llama: Any = None
        self._load_task: asyncio.Task[None] | None = None
        self._gen_lock = asyncio.Lock()

    # ------------------------------------------------------------- paths --
    @property
    def model_dir(self) -> Path:
        raw = Path(self.settings.local_model_dir)
        if raw.is_absolute():
            return raw
        return Path(__file__).resolve().parents[1] / raw

    @property
    def download_url(self) -> str:
        if self.settings.local_model_url:
            return self.settings.local_model_url
        return (
            f"https://huggingface.co/{self.settings.local_model_repo}"
            f"/resolve/main/{self.settings.local_model_file}"
        )

    @property
    def model_path(self) -> Path:
        if self.settings.local_model_url:
            try:
                tail = urlsplit(self.settings.local_model_url).path.rsplit("/", 1)[-1]
            except Exception:
                tail = ""
            name = _safe_filename(tail or "edunova-model.gguf")
        else:
            name = _safe_filename(self.settings.local_model_file)
        return self.model_dir / name

    # ---------------------------------------------------------- snapshot --
    def snapshot(self) -> dict[str, Any]:
        return {
            "state": self.state,
            "ready": self.state == "ready",
            "modelId": self.settings.local_model_id,
            "fileName": self.model_path.name,
            "fileSizeBytes": self.file_size_bytes or None,
            "downloadedBytes": self.downloaded_bytes if self.state == "downloading" else None,
            "contextSize": self.settings.local_model_ctx_size,
            "threads": self.settings.local_model_threads,
            "chatFormat": self.settings.local_model_chat_format,
            "lastError": self.last_error or None,
            "errorDetail": self.error_detail[:200] or None,
            "loadedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(self.ready_at)) if self.ready_at else None,
        }

    @staticmethod
    def _looks_like_download_error(message: str) -> bool:
        lowered = message.lower()
        return any(
            token in lowered
            for token in (
                "download", "http", "tls/ssl", "ssl", "connection", "timed out",
                "name or service", "getaddrinfo", "network", "read error",
            )
        )

    # ------------------------------------------------------------ loading --
    def ensure_loading(self) -> None:
        """Kick off background download+load exactly once (no blocking)."""
        if self.settings.llm_provider != "local":
            return
        if not self.settings.local_preload_model:
            return
        if self._load_task is None or self._load_task.done():
            try:
                loop = asyncio.get_running_loop()
            except RuntimeError:
                return
            self._load_task = loop.create_task(self._load_pipeline())

    async def wait_ready(self, timeout: float) -> None:
        """Wait for the model to become usable; raise a real error otherwise."""
        if self.settings.llm_provider != "local":
            raise LLMConfigurationError("LocalModelManager used while LLM_PROVIDER is not 'local'")
        if self.state == "ready" and self._llama is not None:
            return
        if self.state == "error":
            # A transient download failure must not brick the service until a
            # restart: allow a fresh attempt after a cooldown window.
            if (
                self.started_at
                and time.time() - self.started_at > 180
                and (self._load_task is None or self._load_task.done())
            ):
                logger.info("LOCAL_MODEL_RETRY_AFTER_ERROR previous=%s", self.last_error)
                self.state = "not_started"
                self._load_task = None
            else:
                raise LLMResponseError(
                    "The self-hosted EduNova model failed to start",
                    status_code=503,
                    error_type="model_unavailable",
                    provider_message=self.last_error or "model load failed",
                )
        self.ensure_loading()
        task = self._load_task
        if task is None:
            raise LLMResponseError(
                "The self-hosted EduNova model is not scheduled to load",
                status_code=503,
                error_type="model_unavailable",
                provider_message="preload disabled and no load task exists",
            )
        try:
            await asyncio.wait_for(asyncio.shield(task), timeout=timeout)
        except asyncio.TimeoutError as exc:
            raise LLMResponseError(
                "The self-hosted EduNova model is still starting (downloading/loading weights)",
                status_code=503,
                error_type="model_loading",
                provider_message=f"state={self.state}",
            ) from exc
        except Exception as exc:
            detail = self.last_error or str(exc)[:200]
            raise LLMResponseError(
                "The self-hosted EduNova model failed to start",
                status_code=503,
                error_type="model_unavailable",
                provider_message=detail,
            ) from exc
        if self.state != "ready" or self._llama is None:
            raise LLMResponseError(
                "The self-hosted EduNova model is unavailable",
                status_code=503,
                error_type="model_unavailable",
                provider_message=self.last_error or "model not ready after load task",
            )

    async def _load_pipeline(self) -> None:
        self.started_at = time.time()
        try:
            await self._download_if_needed()
            await self._load_model()
            self.ready_at = time.time()
            elapsed = self.ready_at - (self.started_at or self.ready_at)
            self.state = "ready"
            logger.info(
                "LOCAL_MODEL_READY model=%s file=%s bytes=%s ctx=%s threads=%s elapsed_s=%.1f",
                self.settings.local_model_id,
                self.model_path.name,
                self.file_size_bytes,
                self.settings.local_model_ctx_size,
                self.settings.local_model_threads,
                elapsed,
            )
        except Exception as exc:  # noqa: BLE001 — surfaced through state, never faked
            self.state = "error"
            self.last_error = str(exc)[:300] or exc.__class__.__name__
            if "llama-cpp-python" in self.last_error or "llama_cpp" in self.last_error:
                self.error_detail = "runtime_missing"
                self.last_error = "llama-cpp-python is not installed in this environment"
            elif "checksum" in self.last_error.lower() or "sha256" in self.last_error.lower():
                self.error_detail = "checksum_mismatch"
            elif self._looks_like_download_error(self.last_error):
                self.error_detail = "download_failed"
            else:
                self.error_detail = "load_failed"
            logger.error("LOCAL_MODEL_ERROR detail=%s error=%s", self.error_detail, self.last_error)

    async def _download_if_needed(self) -> None:
        path = self.model_path
        if path.exists() and path.stat().st_size >= _MIN_MODEL_BYTES:
            self.file_size_bytes = path.stat().st_size
            logger.info("LOCAL_MODEL_CACHE_HIT file=%s bytes=%s", path.name, self.file_size_bytes)
            return

        url = self.download_url
        path.parent.mkdir(parents=True, exist_ok=True)
        part = path.with_suffix(path.suffix + ".part")
        self.state = "downloading"
        self.downloaded_bytes = 0
        logger.info("LOCAL_MODEL_DOWNLOAD_START file=%s host=%s", path.name, urlsplit(url).hostname)

        timeout = httpx.Timeout(30.0, read=120.0, connect=15.0)
        started = time.time()
        try:
            async with httpx.AsyncClient(timeout=timeout, follow_redirects=True, max_redirects=5) as client:
                async with client.stream("GET", url, headers={"User-Agent": _USER_AGENT}) as response:
                    if response.status_code >= 400:
                        raise RuntimeError(f"model download failed with HTTP {response.status_code}")
                    with open(part, "wb") as handle:
                        async for chunk in response.aiter_bytes(1024 * 1024):
                            handle.write(chunk)
                            self.downloaded_bytes += len(chunk)
                            if time.time() - started > self.settings.local_model_download_timeout:
                                raise RuntimeError("model download timed out")
        except Exception:
            try:
                part.unlink(missing_ok=True)
            except Exception:
                pass
            raise

        size = part.stat().st_size
        if size < _MIN_MODEL_BYTES:
            part.unlink(missing_ok=True)
            raise RuntimeError(f"downloaded file too small ({size} bytes); refusing to load")

        expected_sha = (self.settings.local_model_sha256 or "").strip().lower()
        if expected_sha:
            digest = hashlib.sha256()
            with open(part, "rb") as handle:
                for block in iter(lambda: handle.read(1024 * 1024), b""):
                    digest.update(block)
            if digest.hexdigest() != expected_sha:
                part.unlink(missing_ok=True)
                raise RuntimeError("model checksum mismatch (sha256 verification failed)")

        os.replace(part, path)
        self.file_size_bytes = size
        logger.info("LOCAL_MODEL_DOWNLOADED file=%s bytes=%s", path.name, size)

    async def _load_model(self) -> None:
        self.state = "loading"
        path = self.model_path

        def _load() -> Any:
            try:
                from llama_cpp import Llama  # noqa: PLC0415 — imported lazily on purpose
            except ImportError as exc:
                raise RuntimeError(
                    "llama-cpp-python is not installed; run `pip install -r ai_engine/requirements.txt`"
                ) from exc
            logger.info(
                "LOCAL_MODEL_LOAD_START file=%s ctx=%s threads=%s",
                path.name,
                self.settings.local_model_ctx_size,
                self.settings.local_model_threads,
            )
            return Llama(
                model_path=str(path),
                n_ctx=self.settings.local_model_ctx_size,
                n_threads=self.settings.local_model_threads,
                n_threads_batch=self.settings.local_model_threads,
                n_batch=self.settings.local_model_batch,
                n_gpu_layers=0,  # CPU-only deployment
                use_mmap=True,   # mmap keeps RSS reclaimable on small Render plans
                use_mlock=False,
                logits_all=False,
                embedding=False,
                verbose=False,
            )

        self._llama = await asyncio.to_thread(_load)

    # --------------------------------------------------------- generation --
    def _render_prompt(self, system_prompt: str, user_prompt: str) -> tuple[str, list[str]]:
        fmt = _CHAT_TEMPLATES.get(self.settings.local_model_chat_format) or _CHAT_TEMPLATES["chatml"]
        return (
            fmt["prompt"].format(system=system_prompt.strip(), user=user_prompt.strip()),
            list(fmt["stops"]),
        )

    async def generate(
        self,
        *,
        system_prompt: str,
        user_prompt: str,
        max_tokens: int,
        temperature: float | None = None,
        json_schema: dict[str, Any] | None = None,
    ) -> str:
        """Single-flight generation; returns raw text. Never fabricates output."""
        await self.wait_ready(self.settings.local_chat_wait_seconds)
        temp = self.settings.llm_temperature if temperature is None else temperature
        bounded_max = max(32, min(int(max_tokens), self.settings.llm_max_output_tokens))

        async with self._gen_lock:
            started = time.monotonic()
            text = await asyncio.to_thread(
                self._generate_sync,
                system_prompt,
                user_prompt,
                bounded_max,
                temp,
                json_schema,
            )
            duration_ms = int((time.monotonic() - started) * 1000)
            logger.info(
                "LOCAL_MODEL_GENERATION model=%s max_tokens=%s json=%s duration_ms=%s chars=%s",
                self.settings.local_model_id,
                bounded_max,
                bool(json_schema),
                duration_ms,
                len(text),
            )
            return text

    def _generate_sync(
        self,
        system_prompt: str,
        user_prompt: str,
        max_tokens: int,
        temperature: float,
        json_schema: dict[str, Any] | None,
    ) -> str:
        llama = self._llama
        if llama is None:
            raise LLMResponseError(
                "The self-hosted EduNova model is unavailable",
                status_code=503,
                error_type="model_unavailable",
                provider_message="model handle missing at generation time",
            )

        grammar = None
        if json_schema:
            try:
                schema_str = json.dumps(json_schema, ensure_ascii=False, separators=(",", ":"))
                from llama_cpp import LlamaGrammar  # noqa: PLC0415

                grammar = LlamaGrammar.from_json_schema(schema_str)
            except Exception as exc:  # grammar support is best-effort
                logger.warning("LOCAL_MODEL_GRAMMAR_UNAVAILABLE reason=%s", str(exc)[:200])
                grammar = None

        prompt, stops = self._render_prompt(system_prompt, user_prompt)
        try:
            result = llama.create_completion(
                prompt=prompt,
                max_tokens=max_tokens,
                temperature=temperature,
                top_p=0.9,
                top_k=40,
                repeat_penalty=1.1,
                stop=stops,
                grammar=grammar,
                echo=False,
            )
        except Exception as exc:
            raise LLMResponseError(
                "The self-hosted EduNova model failed during generation",
                status_code=502,
                error_type="provider_error",
                provider_message=str(exc)[:300],
            ) from exc

        choices = result.get("choices", []) if isinstance(result, dict) else []
        text = ""
        if choices:
            text = str(choices[0].get("text", "") or "")
        if not text.strip():
            raise LLMResponseError(
                "The self-hosted EduNova model returned an empty response",
                status_code=502,
                error_type="invalid_response",
                provider_message="empty completion from local model",
            )
        return text.strip()


class LocalLlamaLLM:
    """Planner-compatible wrapper around the in-process local model."""

    is_local = True

    def __init__(self, settings: Settings, manager: LocalModelManager | None = None):
        self.settings = settings
        self.manager = manager or LocalModelManager(settings)

    async def probe(self) -> None:
        """Health check: succeeds only if the model is actually loaded and ready."""
        await self.manager.wait_ready(timeout=min(5, self.settings.local_chat_wait_seconds))

    async def complete_json(
        self,
        *,
        system_prompt: str,
        user_prompt: str,
        retries: int = 2,
        max_output_tokens: int | None = None,
        json_schema: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        if self.settings.llm_provider != "local":
            raise LLMConfigurationError("LocalLlamaLLM used while LLM_PROVIDER is not 'local'")
        schema = json_schema if json_schema is not None else DECISION_SCHEMA
        max_tokens = max_output_tokens or min(self.settings.llm_max_output_tokens, 480)
        last_error: Exception | None = None
        for attempt in range(retries + 1):
            try:
                text = await self.manager.generate(
                    system_prompt=system_prompt,
                    user_prompt=user_prompt,
                    max_tokens=max_tokens,
                    json_schema=schema,
                )
                return parse_json_object(text)
            except LLMResponseError as exc:
                last_error = exc
                # Loading/unavailable states are not retryable inside one call;
                # the Express layer already retries those with backoff.
                if exc.error_type in {"model_loading", "model_unavailable"}:
                    raise
                if exc.error_type == "invalid_response" and attempt < retries:
                    logger.info("LOCAL_MODEL_JSON_RETRY attempt=%s", attempt + 1)
                    continue
                raise
        assert last_error is not None
        raise last_error

    async def complete_text(
        self,
        *,
        system_prompt: str,
        user_prompt: str,
        max_output_tokens: int | None = None,
        temperature: float | None = None,
    ) -> str:
        """Plain-text generation used by deterministic fast paths."""
        if self.settings.llm_provider != "local":
            raise LLMConfigurationError("LocalLlamaLLM used while LLM_PROVIDER is not 'local'")
        max_tokens = max_output_tokens or self.settings.llm_max_output_tokens
        return await self.manager.generate(
            system_prompt=system_prompt,
            user_prompt=user_prompt,
            max_tokens=max_tokens,
            temperature=temperature,
            json_schema=None,
        )


def create_llm(settings: Settings) -> tuple[Any, LocalModelManager | None]:
    """Factory: returns (llm, local_manager). Keeps legacy providers opt-in."""
    if settings.llm_provider == "local":
        manager = LocalModelManager(settings)
        return LocalLlamaLLM(settings, manager), manager
    from .llm import OpenAICompatibleLLM  # legacy/manual override only

    return OpenAICompatibleLLM(settings), None
