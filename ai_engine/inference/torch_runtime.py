"""PyTorch-first self-hosted inference runtime for EduNova AI.

This module implements the redesigned AI compute layer:

- Model weights are fetched **once, at service startup** (HuggingFace repo or
  a local model directory) into a persistent cache.  A user request NEVER
  triggers a download or a cold load — see ``LocalModelManager``-compatible
  ``wait_ready`` / ``ensure_loading`` and the API-level request queue.
- Inference runs under ``torch.inference_mode()`` with real streaming: tokens
  are decoded one at a time through a dynamic KV cache, so first-token latency
  and tokens/second are measured (and reported via /metrics & /diagnostics),
  never estimated.
- Optional quantizations: dynamic INT8 (``torch.ao.quantization``, per-module
  conversion so peak memory stays bounded) and BF16/FP32.  ``LOCAL_MODEL_DTYPE
  = auto`` picks the best fit from the actual container memory (adaptive
  compute; see ``inference/adaptive.py``).  ``torch.compile`` is opt-in
  (``LOCAL_MODEL_TORCH_COMPILE=1``) because on small shared CPUs it is usually
  slower than eager + int8 — it is benchmarked, not blindly enabled.
- Generation is single-flight per instance (shared CPU reality); concurrent
  requests queue on an asyncio lock and a thread lock with a bounded wait —
  they are never dropped while another request is decoding.

The public surface intentionally mirrors ``agent.local_llm.LocalModelManager``
and ``LocalLlamaLLM`` so the orchestrator, intent router and FastAPI layer
consume either runtime through the same contract.  The legacy llama.cpp GGUF
runtime remains available via ``LOCAL_MODEL_RUNTIME=llama_cpp``.
"""

from __future__ import annotations

import asyncio
import functools
import logging
import os
import re
import threading
import time
from pathlib import Path
from typing import Any

try:  # ai_engine/ directory on sys.path (uvicorn main:app, tests, direct runs)
    from agent.llm import LLMConfigurationError, LLMResponseError, parse_json_object
    from config import Settings
except ImportError:  # imported as ai_engine.inference.torch_runtime (packaged)
    from ..agent.llm import LLMConfigurationError, LLMResponseError, parse_json_object
    from ..config import Settings
from . import adaptive
from .lifecycle import (
    BUSY,
    DEGRADED,
    DOWNLOADING,
    ERROR,
    LOADING,
    READY,
    STARTING,
    WARMING,
    ModelLifecycle,
)

logger = logging.getLogger("edunova.inference.torch")

# Default decision JSON schema (mirrors agent.local_llm.DECISION_SCHEMA).
DECISION_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "action": {"type": "string", "enum": ["tool", "final"]},
        "toolName": {"type": "string"},
        "toolInput": {"type": "object"},
        "answer": {"type": "string"},
        "status": {"type": "string"},
        "stateUpdate": {"type": "object"},
    },
    "required": ["action"],
    "additionalProperties": True,
}

# Fallback chat template used when the tokenizer has no chat_template.
_FALLBACK_TEMPLATE = (
    "{system}\n\n{user}\n\nAssistant: "
)

_STOP_TOKEN_TEXT = re.compile(r"<\|[^|]+\|>")
_LEGACY_STATE_ATTRS = {
    "not_started": STARTING,
    "starting": STARTING,
    "downloading": DOWNLOADING,
    "loading": LOADING,
    "warming": WARMING,
    "warming_up": WARMING,
    "ready": READY,
    "busy": BUSY,
    "degraded": DEGRADED,
    "error": ERROR,
}


def _iso(timestamp: float | None) -> str | None:
    if timestamp is None:
        return None
    from datetime import datetime, timezone

    return datetime.fromtimestamp(timestamp, tz=timezone.utc).isoformat()


def runtime_available() -> bool:
    """True when torch + transformers can be imported in this environment."""
    try:
        import torch  # noqa: PLC0415, F401
        import transformers  # noqa: PLC0415, F401

        return True
    except Exception:
        return False


def runtime_version() -> str:
    try:
        import torch  # noqa: PLC0415
        import transformers  # noqa: PLC0415

        return f"torch={torch.__version__} transformers={transformers.__version__}"
    except Exception:
        return ""


def _safe_id(value: str, limit: int = 160) -> str:
    return re.sub(r"[^A-Za-z0-9._/:-]+", "-", str(value or ""))[:limit]


def _count_tokens(tokenizer: Any, text: str) -> int:
    try:
        return len(tokenizer.encode(text, add_special_tokens=False))
    except Exception:
        return max(1, len(text) // 3)


def _module_count_parameters(config: Any) -> int:
    """Best-effort parameter estimate from a HF model config.

    Estimates the transformer block params + embeddings + lm_head so the
    adaptive dtype picker can decide what fits in RAM before loading.
    """
    try:
        hidden = int(getattr(config, "hidden_size", 0) or 0)
        layers = int(getattr(config, "num_hidden_layers", 0) or 0)
        intermediate = int(getattr(config, "intermediate_size", 0) or 0)
        vocab = int(getattr(config, "vocab_size", 0) or 0)
        if not hidden or not layers:
            return 0
        per_layer = 12 * hidden * hidden + 2 * hidden * intermediate
        head = 2 * vocab * hidden  # embeddings + lm_head (tied often, over-est ok)
        return max(0, int(per_layer * layers + head))
    except Exception:
        return 0


class TorchModelManager:
    """Owns the download -> load -> warmup lifecycle of the PyTorch model.

    Compatible with the parts of ``LocalModelManager`` that the FastAPI layer
    consumes (``state``, ``snapshot``, ``wait_ready``, ``ensure_loading``,
    ``self_test``, ``preflight``, ``error_report``, ``last_error``, ...).
    """

    def __init__(self, settings: Settings):
        self.settings = settings
        # legacy vocabulary on `.state`, canonical machine on `.lifecycle`
        self.state = "not_started"
        self.lifecycle = ModelLifecycle(STARTING)
        self.last_error: str = ""
        self.error_detail: str = ""
        self.error_report: dict[str, Any] | None = None
        self.config_override_rejected: dict[str, Any] | None = None
        self.started_at: float | None = None
        self.ready_at: float | None = None
        self.downloaded_bytes: int = 0
        self.download_attempts: int = 0
        self.last_inference_at: float | None = None
        self.last_generation_metrics: dict[str, Any] | None = None
        self.last_self_test: dict[str, Any] | None = None
        self.last_first_token_ms: int | None = None
        self.cold_start_ms: int | None = None
        self.warmup_ms: int | None = None
        self.model_load_ms: int | None = None

        self._model: Any = None
        self._tokenizer: Any = None
        self._tokenizer_config: dict[str, Any] = {}
        self._config: Any = None
        self._dtype: str = "auto"
        self._device: str = "cpu"
        self._parameter_count: int = 0
        self._compile_mode: str = "off"
        self._load_task: asyncio.Task[None] | None = None
        self._gen_lock = asyncio.Lock()
        self._infer_thread_lock = threading.Lock()
        self._tokens_per_second: float | None = None
        self._model_path: Path | None = None
        self._torch_setup_done = False
        # Single source of truth for "the model can serve a request right now".
        # `state`/`lifecycle` are *reporting* fields; this flag is only ever set
        # to True at the very end of a successful load+warm-up pipeline, so a
        # failed warm-up can never leave the manager advertising readiness.
        self._ready = False
        # Restart guard for the load pipeline. A readiness poll (which arrives
        # every ~2s from the API gateway) must NOT be able to relaunch a failed
        # pipeline immediately — that turns a single startup failure into an
        # endless download/load/OOM thrash that never converges on READY.
        self._load_failures = 0
        self._retry_not_before = 0.0
        # Monotonic counter of load attempts (diagnostics only).
        self._load_generation = 0

    # ------------------------------------------------------------ paths --
    @property
    def model_dir(self) -> Path:
        raw = Path(self.settings.local_model_dir)
        if raw.is_absolute():
            return raw
        return Path(__file__).resolve().parents[1] / raw

    @property
    def model_path(self) -> Path:
        """Directory containing the model (config.json + weights)."""
        if self._model_path is not None:
            return self._model_path
        return adaptive.model_cache_path(
            str(self.model_dir / "hf"), self.settings.local_model_repo
        )

    @property
    def download_url(self) -> str:
        repo = self.settings.local_model_repo
        if not repo:
            return ""
        if Path(repo).exists():
            return str(Path(repo).resolve())
        return f"https://huggingface.co/{repo}"

    @property
    def safe_url(self) -> str:
        return self.download_url

    @staticmethod
    def _find_cached_snapshot(cache_dir: Path, repo: str) -> Path | None:
        """Locate an already-downloaded HuggingFace snapshot for ``repo``.

        Mirrors the real hub layout: ``<cache>/models--<org>--<name>/snapshots/<sha>/``.
        Returns the newest snapshot that contains both a config and weights.
        """
        try:
            base = cache_dir / f"models--{str(repo).strip('/').replace('/', '--')}" / "snapshots"
            if not base.is_dir():
                return None
            candidates = [
                snap for snap in base.iterdir()
                if snap.is_dir()
                and (snap / "config.json").exists()
                and any(snap.glob("*.safetensors") or snap.glob("*.bin"))
            ]
            if not candidates:
                return None
            return max(candidates, key=lambda p: p.stat().st_mtime)
        except OSError:
            return None

    def _uses_local_dir(self) -> bool:
        candidate = Path(self.settings.local_model_repo)
        return (candidate / "config.json").exists() or (self.model_dir / "config.json").exists()

    # ---------------------------------------------------------- snapshot --
    def snapshot(self, include_source: bool = False) -> dict[str, Any]:
        path = self.model_path
        try:
            exists = path.exists()
            on_disk_bytes = sum(f.stat().st_size for f in path.rglob("*")) if exists and path.is_dir() else 0
        except OSError:
            exists, on_disk_bytes = False, 0
        payload: dict[str, Any] = {
            "state": self.state,
            "lifecycle": self.lifecycle.snapshot(),
            "ready": self.is_ready(),
            "modelId": self.settings.local_model_id,
            "modelRepo": self.settings.local_model_repo,
            "fileName": "config.json",
            "fileExists": exists,
            "fileSizeBytes": on_disk_bytes or None,
            "downloadedBytes": self.downloaded_bytes if self.state == "downloading" else None,
            "downloadAttempts": self.download_attempts or None,
            "runtimeAvailable": runtime_available(),
            "runtimeVersion": runtime_version(),
            "runtimeName": "torch",
            "inferenceAvailable": self.is_ready(),
            "lastInferenceAt": _iso(self.last_inference_at),
            "lastGeneration": self.last_generation_metrics,
            "lastSelfTest": self.last_self_test,
            "contextSize": self.settings.local_model_ctx_size,
            "threads": adaptive.pick_threads(self.settings.local_model_threads),
            "dtype": self._dtype,
            "device": self._device,
            "compileMode": self._compile_mode,
            "torchCompiled": bool(getattr(self._model, "_edunova_compiled", False)),
            "chatFormat": "chat_template" ,
            "lastError": self.last_error or None,
            "errorDetail": self.error_detail[:200] or None,
            "loadedAt": _iso(self.ready_at),
            "overrideRejected": bool(self.config_override_rejected),
            "parameterEstimate": self._parameter_count or None,
            "coldStartMs": self.cold_start_ms,
            "warmupMs": self.warmup_ms,
            "modelLoadMs": self.model_load_ms,
            "tokensPerSecond": round(self._tokens_per_second, 2) if self._tokens_per_second else None,
            "tokenizerLoaded": self._tokenizer is not None,
            "modelLoaded": self._model is not None,
            "warmupComplete": bool(self._ready),
            "retryInSeconds": int(self.retry_after_seconds()) or None,
            "loadFailures": self._load_failures or None,
        }
        if include_source:
            payload["sourceUrl"] = self.safe_url
            payload["sourceCheck"] = {"localDir": self._uses_local_dir(), "resolved": str(path)[:300]}
            payload["errorReport"] = self.error_report
        return payload

    # ------------------------------------------------------------ loading --
    def is_ready(self) -> bool:
        """The ONE authoritative readiness answer for this process.

        READY means all four of: tokenizer loaded, weights loaded, the warm-up
        inference succeeded, and no load failure since. It is deliberately not
        derived from ``state``: ``state`` is a coarse reporting string that the
        generation path flips to "busy"/"ready" around every request, so using
        it as the readiness gate is what previously let a *failed warm-up* be
        advertised as READY (the /ready endpoint returned 200 while the model
        could not actually answer).
        """
        return bool(
            self._ready
            and self._model is not None
            and self._tokenizer is not None
        )

    def ensure_loading(self, force: bool = False) -> None:
        """Kick off the background download+load+warmup once (never blocking).

        ``force=True`` starts the pipeline even when preload is disabled; the
        readiness endpoint uses this so a gateway's request queue can wake a
        scale-to-zero/cold service instead of waiting forever for a model that
        nobody started.

        Single-flight AND restart-guarded: repeated calls are no-ops while the
        pipeline runs, while the model is ready, and during the backoff window
        after a failure. Without the backoff, the gateway's 2-second readiness
        poll relaunches a failed pipeline ~300 times per request, so a single
        startup fault (OOM, bad repo, missing file) becomes an endless
        download/load thrash that can never converge on READY.
        """
        if self.is_ready():
            return
        if not self.settings.local_preload_model and not force:
            return
        if self._load_task is not None and not self._load_task.done():
            return  # already loading — never start a second pipeline
        if self._retry_not_before and time.time() < self._retry_not_before:
            return  # cooling down after a failure; do not thrash
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        self._load_generation += 1
        self._load_task = loop.create_task(self._load_pipeline())

    def retry_after_seconds(self) -> float:
        """Seconds until the next load attempt is allowed (0 = right now)."""
        if not self._retry_not_before:
            return 0.0
        return max(0.0, self._retry_not_before - time.time())

    async def wait_ready(self, timeout: float) -> None:
        """Wait until the model is READY (weights + warm-up inference done)."""
        if self.is_ready():
            return
        if self.state == "error" and self.retry_after_seconds() > 0:
            raise LLMResponseError(
                "The self-hosted EduNova model failed to start",
                status_code=503,
                error_type="model_unavailable",
                provider_message=self.last_error or "model load failed",
            )
        self.ensure_loading(force=True)
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
                "The self-hosted EduNova model is still starting",
                status_code=503,
                error_type="model_loading",
                provider_message=f"state={self.state}",
            ) from exc
        except Exception as exc:
            raise LLMResponseError(
                "The self-hosted EduNova model failed to start",
                status_code=503,
                error_type="model_unavailable",
                provider_message=self.last_error or str(exc)[:200],
            ) from exc
        if not self.is_ready():
            raise LLMResponseError(
                "The self-hosted EduNova model is unavailable",
                status_code=503,
                error_type="model_unavailable",
                provider_message=self.last_error or "model not ready after load task",
            )

    # ------------------------------------------------------------ pipeline --
    async def _load_pipeline(self) -> None:
        self.started_at = time.time()
        self.error_report = None
        self._ready = False
        try:
            logger.info("[AI] Starting service")
            logger.info(
                "[AI] Loading configuration model=%s runtime=torch dtype=%s device=%s ctx=%s",
                self.settings.local_model_id,
                self.settings.local_model_dtype,
                self.settings.local_model_device,
                self.settings.local_model_ctx_size,
            )
            self._set_legacy("loading")
            self.lifecycle.transition(STARTING, "pipeline start")
            started = time.time()
            # Download/verify happens ONLY here (startup). Requests never reach
            # this code path: they call wait_ready() which awaits this task.
            await self._obtain_weights()
            load_started = time.monotonic()
            await self._load_model()
            self._configure_quantization_and_compile()
            self.model_load_ms = int((time.monotonic() - load_started) * 1000)
            # WARMING: a real warm-up inference proves the runtime is functional
            # before READY is advertised (/ready returns 200 only then).
            self.state = "warming"
            self.lifecycle.transition(WARMING, "weights loaded; running warm-up")
            logger.info("[AI] Running warmup")
            warm_started = time.monotonic()
            self.last_self_test = await self.self_test(warmup=True)
            self.warmup_ms = int((time.monotonic() - warm_started) * 1000)
            logger.info("[AI] Warmup successful warmup_ms=%s", self.warmup_ms)
            self.ready_at = time.time()
            self.cold_start_ms = int((self.ready_at - self.started_at) * 1000)
            # Only NOW is the model genuinely usable. Everything above must have
            # succeeded: weights, tokenizer and a real warm-up inference.
            self._ready = True
            self._load_failures = 0
            self._retry_not_before = 0.0
            self.state = "ready"
            self.lifecycle.transition(READY, "ready for inference")
            self.last_error = ""
            self.error_detail = ""
            self.error_report = None
            logger.info("[AI] MODEL READY")
            logger.info(
                "TORCH_MODEL_READY model=%s dtype=%s device=%s params=%s cold_start_ms=%s selftest=%s",
                self.settings.local_model_id,
                self._dtype,
                self._device,
                self._parameter_count,
                self.cold_start_ms,
                (self.last_self_test or {}).get("ok"),
            )
        except Exception as exc:  # noqa: BLE001 — surfaced through state
            # EVERY failure (including LLMResponseError from a failed warm-up)
            # must land here. Previously LLMResponseError was re-raised without
            # recording anything, leaving state="ready" (the generation path had
            # already reset it) while lifecycle stayed WARMING and the model was
            # unusable — i.e. /ready answered 200 for a model that could not
            # generate. Never hide the exception; never advertise false READY.
            self._record_startup_error(exc)

    def _record_startup_error(self, exc: Exception) -> None:
        self._ready = False
        self.state = "error"
        self.lifecycle.transition(ERROR, "startup failed")
        message = str(exc)[:400] or exc.__class__.__name__
        provider_message = str(getattr(exc, "provider_message", "") or "")
        if provider_message and provider_message not in message:
            message = f"{message} ({provider_message[:200]})"
        # Exponential backoff so a readiness poll cannot relaunch the pipeline
        # every 2 seconds. Bounded: the service always retries eventually.
        self._load_failures += 1
        backoff = min(300.0, 15.0 * (2 ** min(self._load_failures - 1, 5)))
        self._retry_not_before = time.time() + backoff
        self.last_error = message
        lowered = message.lower()
        if "out of memory" in lowered or "oom" in lowered or "cannot allocate" in lowered:
            self.error_detail = "insufficient_memory"
        elif "no module named" in lowered or "import" in lowered and "torch" in lowered:
            self.error_detail = "runtime_missing"
        elif "404" in lowered or "not found" in lowered or "repositorynotfound" in lowered:
            self.error_detail = "model_not_found"
        elif "401" in lowered or "403" in lowered or "gated" in lowered or "authentication" in lowered:
            self.error_detail = "model_access_denied"
        elif "connect" in lowered or "download" in lowered or "resolve" in lowered or "timeout" in lowered:
            self.error_detail = "download_failed"
        elif "upgrade torch" in lowered or "version" in lowered:
            self.error_detail = "dependency_conflict"
        else:
            self.error_detail = "load_failed"
        hints = {
            "insufficient_memory": (
                "The container ran out of RAM loading the model. Use a smaller model "
                "(LOCAL_MODEL_REPO) or a larger instance; see /api/ai/model/status for sizing."
            ),
            "runtime_missing": "Install the runtime: pip install -r ai_engine/requirements.txt",
            "model_not_found": (
                "LOCAL_MODEL_REPO does not exist on HuggingFace (HTTP 404). Copy the exact "
                "repo id from https://huggingface.co/<repo>."
            ),
            "model_access_denied": "The model repository is gated/private; use a public model.",
            "download_failed": "Check outbound network access to huggingface.co from the AI service.",
            "dependency_conflict": (
                "torch/transformers version mismatch. transformers>=4.56 requires torch>=2.6 "
                "to load .bin checkpoints; pin compatible versions in requirements.txt."
            ),
        }
        self.error_report = {
            "code": "MODEL_STARTUP_ERROR",
            "model": self.settings.local_model_id,
            "url": self.safe_url,
            "status": None,
            "stage": self.error_detail,
            "reason": self.last_error,
            "hint": hints.get(self.error_detail, "Check LOCAL_MODEL_REPO / LOCAL_MODEL_DIR."),
            "permanent": self.error_detail in {"runtime_missing", "model_not_found", "model_access_denied"},
            "attempt": self._load_failures,
            "retryInSeconds": int(self.retry_after_seconds()),
        }
        # Never hide the exception — full traceback to the service log.
        logger.error(
            "[AI] MODEL STARTUP FAILED\nReason: %s\nModel: %s\nStage: %s\nHint: %s\nRetry in: %ss",
            self.last_error,
            self.settings.local_model_id,
            self.error_detail,
            self.error_report["hint"],
            int(self.retry_after_seconds()),
            exc_info=exc,
        )

    def _set_legacy(self, value: str) -> None:
        self.state = value
        canonical = _LEGACY_STATE_ATTRS.get(value, STARTING)
        if self.lifecycle.state != canonical:
            self.lifecycle.transition(canonical)

    # ------------------------------------------------------------- weights --
    async def _obtain_weights(self) -> None:
        """Resolve the model directory: local dir, cached snapshot, or download.

        Runs at STARTUP ONLY. When the weights are already cached (persistent
        disk) this returns instantly — the whole point of model caching.
        """
        if self._uses_local_dir():
            logger.info("TORCH_MODEL_SOURCE local_dir=%s", self.model_path)
            return
        repo = self.settings.local_model_repo
        if not repo:
            raise LLMConfigurationError("LOCAL_MODEL_REPO is required for the torch runtime")
        target = self.model_path
        if (target / "config.json").exists():
            logger.info("TORCH_MODEL_CACHE_HIT repo=%s path=%s (no download)", repo, target)
            return
        # Real HuggingFace cache layout check. `snapshot_download(cache_dir=X)`
        # writes to X/models--<org>--<name>/snapshots/<sha>/, NOT to the flat
        # path above — so the flat check ALWAYS missed and the weights were
        # re-downloaded on every single boot (and, on a slow/blocked network,
        # the service never reached READY). Resolving the cached snapshot makes
        # the persistent disk actually work: download once, warm boots reuse it.
        cached = self._find_cached_snapshot(target.parent, repo)
        if cached is not None:
            self._model_path = cached
            logger.info("TORCH_MODEL_CACHE_HIT repo=%s snapshot=%s (no download)", repo, cached)
            return
        self._set_legacy("downloading")
        self.lifecycle.transition(DOWNLOADING, "fetching weights")
        self.download_attempts += 1
        logger.info("TORCH_MODEL_DOWNLOAD_START repo=%s cache_dir=%s", repo, target.parent)
        try:
            from huggingface_hub import snapshot_download  # noqa: PLC0415
        except ImportError as exc:  # pragma: no cover - huggingface_hub ships with transformers
            raise LLMConfigurationError(
                "huggingface_hub is not installed; `pip install huggingface_hub`"
            ) from exc
        # Only fetch what the text-generation runtime actually needs. Without
        # this, snapshot_download pulls every file in the repo (ONNX exports,
        # GGUF variants, duplicate .bin + .safetensors), which on a small
        # instance means a multi-GB download that can time out before READY.
        local = await asyncio.to_thread(
            functools.partial(
                snapshot_download,
                repo_id=repo,
                revision=self.settings.local_model_hf_revision,
                cache_dir=str(target.parent),
                local_dir=None,
                allow_patterns=[
                    "*.json",
                    "*.safetensors",
                    "*.model",
                    "*.txt",
                    "tokenizer*",
                ],
                ignore_patterns=["*.onnx", "*.gguf", "*.msgpack", "*.h5", "*.pth", "*consolidated*"],
                max_workers=2,
            )
        )
        self._model_path = Path(local)
        try:
            self.downloaded_bytes = sum(
                f.stat().st_size for f in Path(local).rglob("*") if f.is_file()
            )
        except OSError:
            pass
        logger.info(
            "TORCH_MODEL_DOWNLOAD_DONE repo=%s local=%s bytes=%s",
            repo, local, self.downloaded_bytes,
        )

    # --------------------------------------------------------------- load --
    async def _load_model(self) -> None:
        self._set_legacy("loading")
        self.lifecycle.transition(LOADING, "loading weights into memory")
        import torch  # noqa: PLC0415
        from transformers import AutoConfig, AutoModelForCausalLM, AutoTokenizer  # noqa: PLC0415

        self._torch_setup()
        path = self.model_path
        logger.info("TORCH_MODEL_LOAD_START path=%s", path)

        config = await asyncio.to_thread(AutoConfig.from_pretrained, str(path), trust_remote_code=self.settings.local_model_trust_remote_code)
        self._config = config
        params = _module_count_parameters(config)
        self._parameter_count = params
        memory_limit = adaptive.memory_limit_bytes()

        requested_dtype = self.settings.local_model_dtype
        if requested_dtype in ("", "auto"):
            self._dtype = adaptive.pick_dtype(
                parameter_count=params,
                memory_limit_bytes_value=memory_limit,
                requested="auto",
            )
        else:
            self._dtype = requested_dtype

        device = self.settings.local_model_device
        self._device = "cuda" if (device == "auto" and torch.cuda.is_available()) else (device if device in ("cuda", "cpu") else "cpu")
        if self._device == "cuda":
            torch_dtype = torch.float16 if self._dtype in ("fp16", "int8") else getattr(torch, "bfloat16" if self._dtype == "bf16" else "float32")
        elif self._dtype == "fp32":
            torch_dtype = torch.float32
        else:
            # bf16 AND int8 both load in bfloat16 (2 bytes/param).
            #
            # THIS IS A MEMORY-SAFETY FIX: int8 previously fell through to
            # float32, so "auto" picked int8 because int8 *fits* (0.5 GB for a
            # 0.5B model) and then loaded 4 bytes/param (~2.7 GB) anyway. On the
            # 2 GB Render Standard instance the process was OOM-killed mid-load,
            # so the model never reached READY. Dynamic int8 quantization is
            # applied AFTER loading, converting one Linear at a time, so peak
            # memory stays at the bf16 footprint instead of the fp32 one.
            torch_dtype = torch.bfloat16
        logger.info(
            "TORCH_MODEL_LOAD dtype=%s device=%s params=%s mem_limit=%s threads=%s",
            self._dtype,
            self._device,
            params,
            memory_limit,
            adaptive.pick_threads(self.settings.local_model_threads),
        )
        offline = bool(os.getenv("HF_HUB_OFFLINE", "") or self._uses_local_dir())

        # Tokenizer FIRST: it is small and fast, so a broken/missing tokenizer
        # fails in milliseconds instead of after a multi-GB weight load.
        logger.info("[AI] Loading tokenizer")
        try:
            tokenizer = await asyncio.to_thread(
                AutoTokenizer.from_pretrained,
                str(path),
                trust_remote_code=self.settings.local_model_trust_remote_code,
                local_files_only=offline,
            )
        except Exception as exc:
            raise RuntimeError(f"tokenizer load failed for {path}: {str(exc)[:300]}") from exc
        self._tokenizer = tokenizer
        self._apply_chat_config(tokenizer)
        logger.info(
            "[AI] Tokenizer loaded vocab=%s chat_template=%s eos=%s",
            getattr(tokenizer, "vocab_size", "?"),
            bool(self._tokenizer_config.get("chat_template")),
            self._tokenizer_config.get("eos_token_id"),
        )

        logger.info("[AI] Loading model")
        try:
            model = await asyncio.to_thread(
                AutoModelForCausalLM.from_pretrained,
                str(path),
                torch_dtype=torch_dtype,
                device_map=None,
                trust_remote_code=self.settings.local_model_trust_remote_code,
                low_cpu_mem_usage=True,
                local_files_only=offline,
            )
        except Exception as exc:
            raise RuntimeError(f"from_pretrained failed for {path}: {str(exc)[:300]}") from exc
        model.eval()
        self._model = model.to(self._device)
        logger.info("[AI] Model loaded dtype=%s device=%s", torch_dtype, self._device)

    def _apply_chat_config(self, tokenizer: Any) -> None:
        """Capture chat-template + stop-token facts used by generation."""
        config: dict[str, Any] = {}
        try:
            config["chat_template"] = bool(getattr(tokenizer, "chat_template", None))
            config["eos_token_id"] = int(tokenizer.eos_token_id) if tokenizer.eos_token_id is not None else None
        except Exception:
            pass
        self._tokenizer_config = config

    def _torch_setup(self) -> None:
        if self._torch_setup_done:
            return
        import torch  # noqa: PLC0415

        threads = adaptive.pick_threads(self.settings.local_model_threads)
        try:
            torch.set_num_threads(threads)
            if self.settings.local_model_threads <= 0:
                logger.info("TORCH_THREADS adaptive=%s", threads)
        except Exception:
            pass
        self._torch_setup_done = True

    def _configure_quantization_and_compile(self) -> None:
        """Apply quantization (int8 dynamic) and optional torch.compile.

        Each optimization is applied only when it is expected to help and is
        safe for the hardware; both are benchmarked via /diagnostics rather
        than blindly enabled. torch.compile defaults OFF on shared CPU (a
        compile takes seconds-minutes and small models rarely benefit).
        """
        import torch  # noqa: PLC0415

        if self._dtype == "int8":
            try:
                logger.info("TORCH_QUANTIZE_START dtype=int8 (dynamic, per-module)")
                self._quantize_dynamic_int8()
                logger.info("TORCH_QUANTIZE_DONE dtype=int8")
            except Exception as exc:  # noqa: BLE001 — degrade gracefully
                logger.warning("TORCH_QUANTIZE_FAILED reason=%s dtype=bf16 fallback", str(exc)[:200])
                self._dtype = "bf16"
                self.error_detail = "quantization_failed"

        compile_mode = self.settings.local_model_torch_compile
        if compile_mode in ("auto", "1", "true", "on") or (
            compile_mode not in ("off", "0", "false", "none") and compile_mode
        ):
            self._compile_mode = str(compile_mode)
            try:
                # Only attempt on supported configs; failures are logged, never fatal.
                model = torch.compile(self._model)  # type: ignore[assignment]
                self._model = model
                setattr(self._model, "_edunova_compiled", True)
                logger.info("TORCH_COMPILE_ENABLED mode=%s", compile_mode)
            except Exception as exc:  # noqa: BLE001
                logger.warning("TORCH_COMPILE_UNAVAILABLE mode=%s reason=%s", compile_mode, str(exc)[:160])
        else:
            self._compile_mode = "off"

    def _quantize_dynamic_int8(self) -> None:
        """Dynamic INT8 quantization of every Linear module, one at a time.

        ``torch.ao.quantization.quantize_dynamic`` is applied per module while
        each module's weights are temporarily in float32, so peak memory stays
        bounded (no full fp32 copy of the model is ever materialized when the
        model was loaded in bf16/fp32).
        """
        import torch  # noqa: PLC0415
        from torch import nn
        from torch.ao.quantization import quantize_dynamic  # type: ignore[attr-defined]

        # Per-module conversion ONLY. Whole-model `quantize_dynamic` deep-copies
        # the entire model, so peak RSS briefly holds two copies — exactly the
        # spike that OOM-kills a 2 GB container. Converting one Linear at a time
        # keeps the peak at (model + one layer).
        #
        # `quantize_dynamic(..., inplace=True)` on a child does NOT swap the
        # module in its parent, so the returned module must be assigned back via
        # setattr — otherwise the model silently stays unquantized.
        model = self._model
        converted = 0
        skipped = 0
        for module in model.modules():
            for name, child in list(module.named_children()):
                if not isinstance(child, nn.Linear):
                    continue
                try:
                    child.float()  # dynamic quantization requires fp32 input weights
                    setattr(module, name, quantize_dynamic(child, {nn.Linear}, dtype=torch.qint8))
                    converted += 1
                except Exception as child_error:  # noqa: BLE001
                    skipped += 1
                    logger.warning(
                        "TORCH_QUANTIZE_SKIP module=%s reason=%s",
                        f"{type(module).__name__}.{name}",
                        str(child_error)[:120],
                    )
        if not converted:
            raise RuntimeError("no Linear modules could be quantized to int8")

        # Dynamic-quantized Linears run `quantized::linear_dynamic`, which
        # accepts ONLY float32 activations. Everything still holding bf16
        # (embeddings, norms, biases) would feed bf16 tensors into them and
        # raise "mixed dtype (CPU): expect parameter to have scalar type of
        # Float" at the first forward pass — i.e. the warm-up fails and the
        # model never reaches READY. Cast the remaining float params/buffers
        # (a small share of a decoder's weights) up to float32.
        promoted = 0
        for module in model.modules():
            if "quantized" in type(module).__module__:
                continue  # never touch a quantized module's packed params
            for attr in ("_parameters", "_buffers"):
                for key, tensor in list(getattr(module, attr, {}).items()):
                    if tensor is not None and tensor.dtype in (torch.bfloat16, torch.float16):
                        getattr(module, attr)[key] = (
                            torch.nn.Parameter(tensor.float(), requires_grad=False)
                            if attr == "_parameters"
                            else tensor.float()
                        )
                        promoted += 1
        logger.info(
            "TORCH_QUANTIZE_MODULES converted=%s skipped=%s promoted_to_fp32=%s",
            converted, skipped, promoted,
        )

    # --------------------------------------------------------- generation --
    def _render_prompt(self, system_prompt: str, user_prompt: str) -> tuple[str, list[str]]:
        tokenizer = self._tokenizer
        if tokenizer is not None and self._tokenizer_config.get("chat_template"):
            try:
                messages = [
                    {"role": "system", "content": system_prompt.strip()},
                    {"role": "user", "content": user_prompt.strip()},
                ]
                prompt = tokenizer.apply_chat_template(
                    messages, tokenize=False, add_generation_prompt=True
                )
                # Only stop markers that genuinely exist in THIS tokenizer's
                # vocabulary. Listing foreign markers ("</s>" for a ChatML model)
                # previously truncated answers, because the substring scan below
                # matches raw decoded text.
                candidates = ("<|im_end|>", "<|endoftext|>", "</s>", "<|end|>", "<|eot_id|>")
                stops = []
                for marker in candidates:
                    try:
                        tid = tokenizer.convert_tokens_to_ids(marker)
                        if isinstance(tid, int) and tid >= 0 and tokenizer.convert_ids_to_tokens(tid) == marker:
                            stops.append(marker)
                    except Exception:
                        continue
                return prompt, stops
            except Exception as exc:  # noqa: BLE001
                logger.warning("TORCH_CHAT_TEMPLATE_FAILED reason=%s", str(exc)[:120])
        return _FALLBACK_TEMPLATE.format(
            system=system_prompt.strip(), user=user_prompt.strip()
        ), []

    @staticmethod
    def _shrink_middle(text: str, target_chars: int) -> str:
        if len(text) <= target_chars or target_chars < 200:
            return text[: max(0, target_chars)]
        head = int(target_chars * 0.45)
        tail = target_chars - head - 40
        return f"{text[:head]}\n\n…[trimmed to fit the model context]…\n\n{text[-tail:]}"

    def _fit_to_context(
        self, prompt: str, max_tokens: int, system_prompt: str, user_prompt: str
    ) -> tuple[str, int]:
        """Guarantee prompt + completion fit in the model context window."""
        tokenizer = self._tokenizer
        if tokenizer is None:
            return prompt, max_tokens
        n_ctx = self.settings.local_model_ctx_size
        reserve = 16
        budget = n_ctx - max_tokens - reserve
        if budget < 64:
            max_tokens = max(32, n_ctx // 3)
            budget = n_ctx - max_tokens - reserve
        used = _count_tokens(tokenizer, prompt)
        if used <= budget:
            return prompt, max_tokens

        original = used
        trimmed_user = user_prompt
        for _ in range(6):
            overflow_ratio = budget / max(1, used)
            target = max(200, int(len(trimmed_user) * overflow_ratio * 0.92))
            if target >= len(trimmed_user):
                target = int(len(trimmed_user) * 0.8)
            trimmed_user = self._shrink_middle(trimmed_user, target)
            prompt, _stops = self._render_prompt(system_prompt, trimmed_user)
            used = _count_tokens(tokenizer, prompt)
            if used <= budget:
                break
        if used > budget:
            max_tokens = max(32, n_ctx - used - reserve)
        logger.warning(
            "TORCH_PROMPT_TRUNCATED n_ctx=%s prompt_tokens=%s->%s max_tokens=%s",
            n_ctx,
            original,
            used,
            max_tokens,
        )
        return prompt, max_tokens

    async def self_test(self, warmup: bool = False) -> dict[str, Any]:
        """Prove inference works: a real forward pass, real tokens.

        The warm-up proves the *runtime* works (weights + tokenizer + sampler +
        KV cache all execute), so ``allow_empty=True``: an empty completion is a
        model-quality signal, not a runtime fault, and must not keep a
        perfectly functional service permanently out of READY.
        """
        started = time.monotonic()
        text = await self.generate(
            system_prompt=(
                "You are EduNova AI, a patient tutor. Answer briefly and completely."
                if not warmup
                else "You are EduNova AI, a helpful assistant. Reply with OK."
            ),
            user_prompt="What is ML?" if not warmup else "What is 2 + 2?",
            max_tokens=256 if not warmup else 8,
            temperature=0.2 if not warmup else 0.0,
            allow_empty=warmup,
        )
        return {
            "ok": True,
            "prompt": "warmup" if warmup else "What is ML?",
            "answer": text[:120],
            "complete": bool(len(text.strip()) >= 2),
            "durationMs": int((time.monotonic() - started) * 1000),
            "sampleChars": len(text.strip()),
            "generation": self.last_generation_metrics,
        }

    async def generate(
        self,
        *,
        system_prompt: str,
        user_prompt: str,
        max_tokens: int,
        temperature: float | None = None,
        json_schema: dict[str, Any] | None = None,
        allow_empty: bool = False,
        on_token: Any = None,
    ) -> str:
        """Single-flight PyTorch generation; returns the complete text.

        Warm-up has its own bounded wait; once decoding starts the model runs
        to EOS or its adaptive token budget — generation is never cut by an
        elapsed-time limit (speed and answer length are separate concerns).
        """
        # Wait for readiness unless the weights are already live. The "warming"
        # state is allowed through because the warm-up inference itself calls
        # generate() from inside the load pipeline (state=warming) — gating on
        # the load task there would deadlock (the pipeline would await itself).
        # `warming` is allowed through because the warm-up inference itself runs
        # from inside the load pipeline; gating it would deadlock (the pipeline
        # would await its own task). Everything else must pass the real gate.
        warming = self.state == "warming" and self._model is not None and self._tokenizer is not None
        if not warming and not self.is_ready():
            await self.wait_ready(self.settings.local_chat_wait_seconds)
        temp = self.settings.llm_temperature if temperature is None else temperature
        bounded_max = max(16, min(int(max_tokens), self.settings.llm_max_output_tokens))

        async with self._gen_lock:
            started = time.monotonic()
            text = ""
            attempts = 1 if allow_empty else 2
            for attempt in range(1, attempts + 1):
                try:
                    text = await asyncio.to_thread(
                        self._generate_sync_protected,
                        system_prompt,
                        user_prompt,
                        bounded_max,
                        temp if attempt == 1 else max(float(temp or 0.2), 0.4),
                        allow_empty,
                        on_token,
                    )
                    break
                except LLMResponseError as exc:
                    if exc.error_type == "invalid_response" and attempt < attempts:
                        logger.info("TORCH_MODEL_EMPTY_RETRY attempt=%s", attempt)
                        continue
                    raise
            duration_ms = int((time.monotonic() - started) * 1000)
            self.last_inference_at = time.time()
            logger.info(
                "TORCH_MODEL_GENERATION model=%s max_tokens=%s duration_ms=%s chars=%s",
                self.settings.local_model_id,
                bounded_max,
                duration_ms,
                len(text),
            )
            return text

    def _generate_sync_protected(
        self,
        system_prompt: str,
        user_prompt: str,
        max_tokens: int,
        temperature: float,
        allow_empty: bool,
        on_token: Any,
    ) -> str:
        """Thread-safe wrapper: even a cancelled asyncio task cannot overlap a
        running torch decode (torch CPU is not safe under concurrent calls)."""
        acquired = self._infer_thread_lock.acquire(timeout=300.0)
        if not acquired:
            raise LLMResponseError(
                "The local model is busy processing another request. Please try again.",
                status_code=503,
                error_type="model_busy",
            )
        # Remember the state we came from. The warm-up inference runs while the
        # manager is "warming"; blindly restoring "ready" afterwards is what let
        # a FAILED warm-up leave state="ready" (lifecycle stuck at WARMING) and
        # made /ready return 200 for an unusable model.
        previous_state = self.state
        try:
            self.state = "busy"
            if self.lifecycle.state in (READY, BUSY):
                self.lifecycle.transition(BUSY)
            try:
                return self._generate_sync(
                    system_prompt, user_prompt, max_tokens, temperature, allow_empty, on_token
                )
            finally:
                self.state = "ready" if self._ready else previous_state
                if self.lifecycle.state == BUSY:
                    self.lifecycle.transition(READY, "generation finished")
        finally:
            self._infer_thread_lock.release()

    def _generate_sync(
        self,
        system_prompt: str,
        user_prompt: str,
        max_tokens: int,
        temperature: float,
        allow_empty: bool,
        on_token: Any,
    ) -> str:
        """Synchronous streaming decode under torch.inference_mode()."""
        import torch  # noqa: PLC0415

        model = self._model
        tokenizer = self._tokenizer
        if model is None or tokenizer is None:
            raise LLMResponseError(
                "The self-hosted EduNova model is unavailable",
                status_code=503,
                error_type="model_unavailable",
                provider_message="model handle missing at generation time",
            )

        prompt, stops = self._render_prompt(system_prompt, user_prompt)
        prompt, max_tokens = self._fit_to_context(prompt, max_tokens, system_prompt, user_prompt)

        try:
            enc = tokenizer(prompt, return_tensors="pt", add_special_tokens=False)
        except Exception:
            enc = tokenizer(prompt, return_tensors="pt")
        input_ids = enc["input_ids"].to(self._device)
        attention_mask = enc.get("attention_mask")
        if attention_mask is not None:
            attention_mask = attention_mask.to(self._device)

        eos_ids: set[int] = set()
        if tokenizer.eos_token_id is not None:
            eos_ids.add(int(tokenizer.eos_token_id))
        # Stop tokens must be resolved STRICTLY. `convert_tokens_to_ids` returns
        # the UNK id for a token that is not in the vocabulary, so mapping
        # generic markers like "</s>" or "<|end|>" against a Qwen2 vocab yielded
        # unk (id 0 = "<|endoftext|>") and made the decoder stop on a perfectly
        # ordinary token — answers were cut off mid-sentence. Only accept an id
        # that round-trips back to the exact same token text.
        unk_id = getattr(tokenizer, "unk_token_id", None)
        stop_ids: list[int] = []
        for stop in stops:
            try:
                tid = tokenizer.convert_tokens_to_ids(stop)
            except Exception:
                continue
            if not isinstance(tid, int) or tid < 0:
                continue
            if unk_id is not None and tid == unk_id and stop != getattr(tokenizer, "unk_token", None):
                continue
            try:
                if tokenizer.convert_ids_to_tokens(tid) != stop:
                    continue  # not a real token in this vocabulary
            except Exception:
                continue
            stop_ids.append(tid)
        if tokenizer.pad_token_id is not None:
            pad_id = int(tokenizer.pad_token_id)
            if pad_id not in eos_ids:
                pass  # pad id should never be sampled with proper masking

        generated_ids: list[int] = []
        pieces: list[str] = []
        text = ""
        past: Any = None
        cur_ids = input_ids
        cur_mask = attention_mask
        # The hard ceiling on total tokens the model can ever process. Reaching
        # it is a graceful stop (like EOS), not an error — generation simply
        # ends when the model's position embeddings run out.
        try:
            model_max_positions = int(getattr(model.config, "max_position_embeddings", 0) or 0)
        except Exception:
            model_max_positions = 0
        cur_seq_len = int(len(input_ids[0]))

        inference_started = time.monotonic()
        first_token_ms: int | None = None
        top_k, top_p = 40, 0.9
        repeat_penalty = 1.1

        try:
            with torch.inference_mode():
                for _step in range(max_tokens):
                    if model_max_positions and cur_seq_len >= model_max_positions:
                        logger.info(
                            "TORCH_CONTEXT_LIMIT model=%s total_tokens=%s max=%s tokens_generated=%s",
                            self.settings.local_model_id,
                            cur_seq_len,
                            model_max_positions,
                            len(generated_ids),
                        )
                        break
                    outputs = model(
                        input_ids=cur_ids,
                        attention_mask=cur_mask,
                        past_key_values=past,
                        use_cache=True,
                    )
                    past = outputs.past_key_values
                    logits = outputs.logits[:, -1, :].float()
                    next_token_id = self._sample(
                        logits,
                        temperature=temperature,
                        top_k=top_k,
                        top_p=top_p,
                        repeat_penalty=repeat_penalty,
                        generated=generated_ids,
                    )
                    next_id = int(next_token_id.item())

                    if next_id in eos_ids or (stop_ids and next_id in stop_ids):
                        break

                    generated_ids.append(next_id)
                    piece = tokenizer.decode([next_id], skip_special_tokens=True)
                    if piece:
                        pieces.append(piece)
                        text += piece
                        if first_token_ms is None:
                            first_token_ms = int((time.monotonic() - inference_started) * 1000)
                        if on_token is not None:
                            try:
                                on_token(piece)
                            except Exception as tok_err:  # noqa: BLE001
                                logger.warning("TORCH_ON_TOKEN_CALLBACK_ERROR %s", str(tok_err)[:120])

                    # Detect stop strings that span multiple tokens.
                    tail = text[-32:]
                    hit = next((s for s in stops if s and s in tail), None)
                    if hit:
                        text = text[: text.rfind(hit)]
                        pieces = [text] if text else []
                        break

                    # Next step continues from the single new token with the KV cache.
                    cur_ids = next_token_id.view(1, 1)
                    cur_seq_len += 1
                    if cur_mask is not None:
                        cur_mask = torch.cat([cur_mask, torch.ones(1, 1, dtype=cur_mask.dtype, device=cur_mask.device)], dim=1)
        except LLMResponseError:
            raise
        except Exception as exc:
            raise LLMResponseError(
                "The self-hosted EduNova model failed during generation",
                status_code=502,
                error_type="provider_error",
                provider_message=str(exc)[:300],
            ) from exc

        text = "".join(pieces)
        text = text.strip()
        if not text and generated_ids:
            text = tokenizer.decode(generated_ids, skip_special_tokens=True).strip()

        # Post-trim any stop text that landed in the decoded result.
        for stop in stops:
            if stop and stop in text:
                cut = text.find(stop)
                if cut >= 0:
                    text = text[:cut].rstrip()

        generation_seconds = max(0.001, time.monotonic() - inference_started)
        generated_tokens = len(generated_ids)
        self._record_throughput(generated_tokens, generation_seconds)
        self.last_generation_metrics = {
            "tokens": generated_tokens,
            "promptTokens": int(len(input_ids[0])),
            "durationMs": int(generation_seconds * 1000),
            "tokensPerSecond": round(generated_tokens / generation_seconds, 2),
            "firstTokenMs": first_token_ms,
            "responseChars": len(text),
        }
        self.last_first_token_ms = first_token_ms
        logger.info(
            "[EduNova AI] Inference completed tokens=%s prompt_tokens=%s duration_ms=%s tokens_per_second=%.2f first_token_ms=%s",
            generated_tokens,
            int(len(input_ids[0])),
            int(generation_seconds * 1000),
            generated_tokens / generation_seconds,
            first_token_ms if first_token_ms is not None else "n/a",
        )
        if not text.strip() and not allow_empty:
            raise LLMResponseError(
                "The self-hosted EduNova model returned an empty response",
                status_code=502,
                error_type="invalid_response",
                provider_message="empty completion from local model",
            )
        return text.strip()

    @staticmethod
    def _sample(
        logits: Any,
        *,
        temperature: float,
        top_k: int,
        top_p: float,
        repeat_penalty: float,
        generated: list[int],
    ) -> Any:
        import torch  # noqa: PLC0415

        if repeat_penalty and repeat_penalty > 1.0 and generated:
            for tid in set(generated[-256:]):
                if 0 <= tid < logits.shape[-1]:
                    logits[:, tid] /= repeat_penalty

        if temperature is not None and temperature > 0:
            logits = logits / max(temperature, 1e-5)
            if top_k and top_k > 0:
                k = min(top_k, logits.shape[-1])
                topk = torch.topk(logits, k)
                logits[logits < topk.values[:, -1:]] = float("-inf")
            if top_p and 0.0 < top_p < 1.0:
                sorted_logits, sorted_indices = torch.sort(logits, descending=True)
                cumprobs = torch.cumsum(torch.softmax(sorted_logits, dim=-1), dim=-1)
                remove = cumprobs > top_p
                remove[..., 1:] = remove[..., :-1].clone()
                remove[..., 0] = False
                sorted_logits[remove] = float("-inf")
                logits = torch.zeros_like(logits).scatter_(1, sorted_indices, sorted_logits)
            probs = torch.softmax(logits, dim=-1)
            return torch.multinomial(probs, num_samples=1)
        return torch.argmax(logits, dim=-1, keepdim=True)

    def _record_throughput(self, tokens: int, seconds: float) -> None:
        if tokens < 4 or seconds <= 0.05:
            return
        observed = tokens / seconds
        if self._tokens_per_second is None:
            self._tokens_per_second = observed
        else:
            self._tokens_per_second = (0.7 * self._tokens_per_second) + (0.3 * observed)

    # -------------------------------------------------------------- misc ---
    async def preflight(self) -> dict[str, Any]:
        """Operator check: is the configured source resolvable?

        For a local dir / cache hit this is trivially OK. For a HuggingFace
        repo we check reachability metadata only (never request weights).
        """
        if self._uses_local_dir() or (self.model_path / "config.json").exists():
            return {"status": "ok", "source": "local_cache", "path": str(self.model_path)}
        repo = self.settings.local_model_repo
        if not repo:
            return {"status": "error", "reason": "missing LOCAL_MODEL_REPO"}
        try:
            from huggingface_hub import HfApi  # noqa: PLC0415

            info = await asyncio.to_thread(
                HfApi().model_info, repo, revision=self.settings.local_model_hf_revision
            )
            return {
                "status": "ok",
                "source": "huggingface",
                "repo": repo,
                "revision": self.settings.local_model_hf_revision,
                "files": [s.rfilename for s in (info.siblings or [])][:50],
            }
        except Exception as exc:
            return {"status": "error", "reason": str(exc)[:200], "repo": repo}


class TorchChatLLM:
    """Orchestrator-compatible wrapper around the PyTorch model manager.

    Implements the same interface as ``agent.local_llm.LocalLlamaLLM``
    (``probe`` / ``complete_json`` / ``complete_text``) so the IntentRouter and
    AgentEngine consume the PyTorch runtime unchanged.
    """

    is_local = True

    def __init__(self, settings: Settings, manager: TorchModelManager | None = None):
        self.settings = settings
        self.manager = manager or TorchModelManager(settings)

    async def probe(self, deep: bool = False) -> None:
        await self.manager.wait_ready(timeout=min(5, self.settings.local_chat_wait_seconds))
        if deep:
            await self.manager.self_test()

    async def complete_json(
        self,
        *,
        system_prompt: str,
        user_prompt: str,
        retries: int = 2,
        max_output_tokens: int | None = None,
        json_schema: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        schema = json_schema if json_schema is not None else DECISION_SCHEMA
        max_tokens = max_output_tokens or min(self.settings.llm_max_output_tokens, 480)
        schema_hint = ""
        try:
            import json as _json  # noqa: PLC0415

            schema_hint = _json.dumps(schema, ensure_ascii=False, separators=(",", ":"))[:1200]
        except Exception:
            pass
        guidance = (
            "\n\nOutput ONLY a single valid JSON object (no markdown fences, no commentary) "
            "matching this schema exactly:\n"
            f"{schema_hint}\n"
            "Required keys are listed in the schema's required array. If you cannot comply, "
            'return {"action": "final", "answer": "I could not parse this request."}'
        )
        last_error: Exception | None = None
        for attempt in range(retries + 1):
            try:
                text = await self.manager.generate(
                    system_prompt=system_prompt,
                    user_prompt=user_prompt + guidance,
                    max_tokens=max_tokens,
                    temperature=0.2,
                )
                return parse_json_object(text)
            except LLMResponseError as exc:
                last_error = exc
                if exc.error_type in {"model_loading", "model_unavailable", "model_busy"}:
                    raise
                if exc.error_type == "invalid_response" and attempt < retries:
                    logger.info("TORCH_JSON_RETRY attempt=%s", attempt + 1)
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
        on_token: Any = None,
    ) -> str:
        max_tokens = max_output_tokens or self.settings.llm_max_output_tokens
        return await self.manager.generate(
            system_prompt=system_prompt,
            user_prompt=user_prompt,
            max_tokens=max_tokens,
            temperature=temperature,
            on_token=on_token,
        )
