"""GGUF weights engine for the EduNova AI INFERENCE service (llama.cpp, CPU).

This module is imported ONLY by the persistent inference service worker
(``inference/manager.py`` -> ``inference_server.py``). The lightweight
orchestrator (``main.py``) never imports it; it reaches the model through the
authenticated HTTP/SSE client in ``agent/remote_llm.py``.

``LocalModelManager`` owns exactly three things and has NO lifecycle state
machine of its own (the supervised ``ModelManager`` is the single authority):

- download-once into ``LOCAL_MODEL_DIR`` (persistent disk), verify size /
  GGUF magic / sha256, never re-download a valid cached file;
- load with mmap (``_load_model``);
- single-flight generation with real token streaming and grammar-constrained
  JSON (``generate``).

Download contract (this is where the previous HTTP 404 outage came from):
- the resolved URL is validated with a preflight HEAD **before** any bytes are
  written, so a wrong ``LOCAL_MODEL_FILE`` fails immediately and loudly;
- permanent failures (404/401/403/410) are never retried — they are a
  configuration bug and are reported as a structured ``MODEL_STARTUP_ERROR``
  block naming the model, the sanitized URL, the status and the reason;
- transient failures (5xx, timeouts, resets) are retried with backoff and the
  partial file is resumed via HTTP Range when the server supports it;
- the finished file is validated on size, GGUF magic and (for catalogue models)
  sha256, then atomically renamed into place.

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
from dataclasses import replace
import hashlib
import inspect
import json
import logging
import os
from pathlib import Path
import re
import threading
import time
from typing import Any
from urllib.parse import urlsplit

import httpx

from config import Settings, catalogue_default_file_for_repo, known_model_entry
from .llm import LLMResponseError

logger = logging.getLogger("edunova.llm.local")

_USER_AGENT = "EduNovaLocalModel/1.0 (+self-hosted)"
_FILENAME_SAFE = re.compile(r"[^A-Za-z0-9._-]+")
_MIN_MODEL_BYTES = 10 * 1024 * 1024  # default floor; see Settings.local_model_min_bytes
_GGUF_MAGIC = b"GGUF"

# HTTP statuses that mean "this will never work" — retrying is pointless and
# only delays the operator seeing the real configuration problem.
_PERMANENT_HTTP_STATUSES = {400, 401, 403, 404, 405, 410, 451}
_HTTP_STATUS_REASONS = {
    401: "authentication required for the model repository (is it gated/private?)",
    403: "access to the model file is forbidden (gated repository or missing token)",
    404: "model file not found at the configured URL",
    410: "model file has been removed from the repository",
    451: "model file is not legally available from this region",
}

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


class ModelSourceError(RuntimeError):
    """A download/verification failure carrying safe, actionable diagnostics.

    ``str(...)`` renders the ``MODEL_STARTUP_ERROR`` block that goes into the
    production logs; ``report()`` returns the same facts as a dict for the
    health endpoint. Neither ever contains credentials: the URL is sanitized
    by ``Settings.local_model_safe_url``.
    """

    def __init__(
        self,
        *,
        model: str,
        url: str,
        reason: str,
        status: int | None = None,
        stage: str = "download",
        hint: str = "",
        permanent: bool = False,
    ):
        self.model = model
        self.url = url
        self.reason = reason
        self.status = status
        self.stage = stage
        self.hint = hint
        self.permanent = permanent
        super().__init__(self.render())

    def render(self) -> str:
        lines = [
            "MODEL_STARTUP_ERROR",
            f"Model: {self.model or 'unknown'}",
            f"URL: {self.url or 'not-configured'}",
            f"Status: {self.status if self.status is not None else 'n/a'}",
            f"Stage: {self.stage}",
            f"Reason: {self.reason}",
        ]
        if self.hint:
            lines.append(f"Fix: {self.hint}")
        return "\n".join(lines)

    def report(self) -> dict[str, Any]:
        return {
            "code": "MODEL_STARTUP_ERROR",
            "model": self.model,
            "url": self.url,
            "status": self.status,
            "stage": self.stage,
            "reason": self.reason,
            "hint": self.hint or None,
            "permanent": self.permanent,
        }


def _iso(timestamp: float | None) -> str | None:
    if not timestamp:
        return None
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(timestamp))


def runtime_available() -> bool:
    """True when the llama.cpp Python runtime can actually be imported."""
    try:
        import llama_cpp  # noqa: F401, PLC0415

        return True
    except Exception:
        return False


def runtime_version() -> str | None:
    try:
        import llama_cpp  # noqa: PLC0415

        return str(getattr(llama_cpp, "__version__", "")) or None
    except Exception:
        return None


def _has_gguf_magic(path: Path) -> bool:
    """Cheap structural check: every GGUF file starts with the ASCII magic."""
    try:
        with open(path, "rb") as handle:
            return handle.read(4) == _GGUF_MAGIC
    except OSError:
        return False


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(4 * 1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


class LocalModelManager:
    """Download-once + mmap load + single-flight generation of the GGUF file."""

    def __init__(self, settings: Settings):
        self.settings = settings
        self.downloaded_bytes: int = 0
        self.file_size_bytes: int = 0
        self.download_attempts: int = 0
        self.last_inference_at: float | None = None
        self.last_generation_metrics: dict[str, Any] | None = None
        self.source_check: dict[str, Any] | None = None
        # Self-healing state for a stale/broken LOCAL_MODEL_FILE override (the
        # production incident: the env pinned a filename that was never
        # published in the repo -> permanent HTTP 404 -> "model unavailable").
        self.config_override_rejected: dict[str, Any] | None = None
        self._override_fallback_attempted: bool = False
        self._llama: Any = None
        self._gen_lock = asyncio.Lock()
        # Thread-level lock: prevents concurrent llama.cpp inference.
        # The asyncio.Lock above releases when an asyncio task is cancelled
        # (e.g. timeout), but the underlying _generate_sync() THREAD continues
        # running. Without this threading.Lock, a second request could start a
        # second llama.cpp call while the first is still running — llama.cpp is
        # NOT thread-safe and this causes deadlocks or crashes.
        self._llama_thread_lock = threading.Lock()
        # Measured decode throughput (tokens/second) for THIS instance, used to
        # size token budgets against the remaining request time. Learned at
        # runtime because it depends on the CPU Render actually gave us.
        self._tokens_per_second: float | None = None

    # ------------------------------------------------------------- paths --
    @property
    def model_dir(self) -> Path:
        raw = Path(self.settings.local_model_dir)
        if raw.is_absolute():
            return raw
        return Path(__file__).resolve().parents[1] / raw

    @property
    def download_url(self) -> str:
        return self.settings.local_model_download_url

    @property
    def safe_url(self) -> str:
        """Resolved download URL, safe to log and to return from /health."""
        return self.settings.local_model_safe_url

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

    @property
    def verified_marker_path(self) -> Path:
        """Sidecar recording the checksum a cached file was verified against.

        Re-hashing 380MB on every cold start costs real CPU seconds on a small
        instance, so a matching marker lets a cache hit skip the rehash while
        still catching a swapped/truncated file through the size check.
        """
        return self.model_path.with_suffix(self.model_path.suffix + ".verified")

    # ---------------------------------------------------------- snapshot --
    def snapshot(self, include_source: bool = False) -> dict[str, Any]:
        """File/runtime facts for the supervisor (no lifecycle state lives here)."""
        path = self.model_path
        try:
            exists = path.exists()
            on_disk_bytes = path.stat().st_size if exists else 0
        except OSError:
            exists, on_disk_bytes = False, 0
        payload: dict[str, Any] = {
            "modelId": self.settings.local_model_id,
            "fileName": path.name,
            "fileExists": exists,
            "fileSizeBytes": (self.file_size_bytes or on_disk_bytes) or None,
            "expectedSizeBytes": self.settings.local_model_expected_size or None,
            "integrityPinned": bool(self.settings.local_model_expected_sha256),
            "downloadedBytes": self.downloaded_bytes or None,
            "downloadAttempts": self.download_attempts or None,
            "runtimeAvailable": runtime_available(),
            "runtimeVersion": runtime_version(),
            "modelLoaded": self._llama is not None,
            "tokenizerLoaded": self._llama is not None,
            "lastInferenceAt": _iso(self.last_inference_at),
            "lastGeneration": self.last_generation_metrics,
            "contextSize": self.settings.local_model_ctx_size,
            "threads": self.settings.local_model_threads,
            "chatFormat": self.settings.local_model_chat_format,
            "overrideRejected": bool(self.config_override_rejected),
        }
        if include_source:
            payload["sourceUrl"] = self.safe_url
            payload["sourceCheck"] = self.source_check
            payload["configOverrideRejected"] = self.config_override_rejected
        return payload

    def is_loaded(self) -> bool:
        return self._llama is not None

    # ------------------------------------------------------------ source --
    def _source_error(self, **kwargs: Any) -> ModelSourceError:
        kwargs.setdefault("model", self.settings.local_model_id)
        kwargs.setdefault("url", self.safe_url)
        return ModelSourceError(**kwargs)

    def _try_recover_invalid_override(self, exc: ModelSourceError) -> bool:
        """Self-heal a stale/broken ``LOCAL_MODEL_FILE`` override.

        The production incident: the environment pinned a filename that was
        never published in the configured repository, the preflight returned a
        permanent HTTP 404, and the service stayed down ("model unavailable")
        until an administrator edited the dashboard. This method closes that
        outage class: when the configured file **provably does not exist**
        (404/410) inside a repository present in the verified catalogue, the
        runtime transparently continues with the catalogue's verified default
        file for that same repo.

        Rules (all must hold — checked explicitly):
        - provider is ``local`` and no custom ``LOCAL_MODEL_URL`` is set
          (a custom URL is a deliberate operator choice and is never overridden);
        - the failure is permanent with status 404/410 (file absent/removed);
        - the configured (repo, file) pair is NOT itself a verified catalogue
          entry — if a pinned catalogue file 404s, that is an upstream outage
          and must stay a loud error, never silently re-pointed;
        - the repo IS a catalogue repo, so a verified fallback exists;
        - the fallback runs at most once per process and is always surfaced
          through logs and ``/health`` (``configOverrideRejected``).

        This is NOT an external fallback and NOT a canned answer: the applied
        model is still the self-hosted GGUF from the same repository, with
        size + sha256 integrity enforced from the catalogue.
        """
        if self._override_fallback_attempted:
            return False
        if self.settings.llm_provider != "local" or self.settings.local_model_url:
            return False
        if not (getattr(exc, "permanent", False) and getattr(exc, "status", None) in (404, 410)):
            return False
        repo = self.settings.local_model_repo
        configured_file = self.settings.local_model_file
        if known_model_entry(repo, configured_file) is not None:
            return False
        fallback = catalogue_default_file_for_repo(repo)
        if not fallback or fallback == configured_file:
            return False

        self._override_fallback_attempted = True
        self.config_override_rejected = {
            "configuredRepo": repo,
            "configuredFile": configured_file,
            "status": exc.status,
            "stage": exc.stage,
            "reason": exc.reason,
            "fallbackFile": fallback,
        }
        logger.warning(
            "MODEL_CONFIG_OVERRIDE_INVALID repo=%s file=%s status=%s stage=%s reason=%s hint=%s",
            repo,
            configured_file,
            exc.status,
            exc.stage,
            exc.reason,
            exc.hint or "n/a",
        )
        logger.warning(
            "MODEL_CONFIG_FALLBACK applying verified catalogue file=%s for repo=%s "
            "(integrity-pinned; set LOCAL_MODEL_FILE to a file listed at "
            "https://huggingface.co/%s/tree/main to silence this)",
            fallback,
            repo,
            repo,
        )
        self.settings = replace(
            self.settings,
            local_model_file=fallback,
            local_model_sha256="",
            local_model_expected_bytes=0,
        )
        # Reset download bookkeeping so the retry starts from a clean slate.
        self.download_attempts = 0
        self.downloaded_bytes = 0
        self.source_check = None
        return True

    def _hint_for_status(self, status: int) -> str:
        if status in (401, 403):
            return (
                "Pick an ungated public GGUF repository, or supply a pre-authorized "
                "LOCAL_MODEL_URL. EduNova never sends credentials to a model host."
            )
        if status in (404, 410):
            return (
                "LOCAL_MODEL_FILE does not exist in LOCAL_MODEL_REPO. Verify the exact "
                "filename at https://huggingface.co/"
                f"{self.settings.local_model_repo}/tree/main and set LOCAL_MODEL_FILE to a "
                "file listed there (default: "
                f"{self.settings.local_model_file})."
            )
        return "Check LOCAL_MODEL_REPO / LOCAL_MODEL_FILE / LOCAL_MODEL_URL."

    async def preflight(self, client: httpx.AsyncClient | None = None) -> dict[str, Any]:
        """Validate the resolved model URL before downloading a single byte.

        Returns ``{"status": int, "contentLength": int|None, "acceptRanges": bool}``
        and raises ``ModelSourceError`` for any non-2xx answer. This is the
        check that turns "model download failed with HTTP 404" into an error
        that names the model, the URL and the fix.
        """
        url = self.download_url
        if not url:
            raise self._source_error(
                reason="no model source configured",
                stage="configuration",
                permanent=True,
                hint="Set LOCAL_MODEL_REPO + LOCAL_MODEL_FILE, or LOCAL_MODEL_URL.",
            )

        owns_client = client is None
        client = client or httpx.AsyncClient(
            timeout=httpx.Timeout(30.0, connect=15.0),
            follow_redirects=True,
            max_redirects=5,
        )
        try:
            try:
                response = await client.head(url, headers={"User-Agent": _USER_AGENT})
                # Some CDNs answer HEAD with 405; fall back to a 1-byte ranged GET.
                if response.status_code in (400, 403, 405, 501):
                    response = await client.get(
                        url, headers={"User-Agent": _USER_AGENT, "Range": "bytes=0-0"}
                    )
            except httpx.HTTPError as exc:
                raise self._source_error(
                    reason=f"model host unreachable ({exc.__class__.__name__})",
                    stage="preflight",
                    hint="Check outbound network/DNS from the AI service.",
                ) from exc

            status = response.status_code
            if status >= 400:
                raise self._source_error(
                    reason=_HTTP_STATUS_REASONS.get(status, f"model host returned HTTP {status}"),
                    status=status,
                    stage="preflight",
                    permanent=status in _PERMANENT_HTTP_STATUSES,
                    hint=self._hint_for_status(status),
                )

            declared = response.headers.get("content-range") or response.headers.get("content-length")
            content_length: int | None = None
            if response.headers.get("content-range"):
                try:
                    content_length = int(str(declared).rsplit("/", 1)[-1])
                except (TypeError, ValueError):
                    content_length = None
            else:
                try:
                    content_length = int(declared) if declared is not None else None
                except (TypeError, ValueError):
                    content_length = None

            accept_ranges = "bytes" in str(response.headers.get("accept-ranges", "")).lower()
            check = {
                "status": status,
                "contentLength": content_length,
                "acceptRanges": accept_ranges,
                "checkedAt": _iso(time.time()),
            }
            self.source_check = check

            expected = self.settings.local_model_expected_size
            if expected and content_length and content_length != expected:
                raise self._source_error(
                    reason=(
                        f"model host reports {content_length} bytes but "
                        f"{expected} bytes were expected for this pinned model"
                    ),
                    status=status,
                    stage="preflight",
                    permanent=True,
                    hint="Clear LOCAL_MODEL_BYTES/LOCAL_MODEL_SHA256 or point at the pinned revision.",
                )
            logger.info(
                "LOCAL_MODEL_SOURCE_OK model=%s url=%s status=%s bytes=%s ranges=%s",
                self.settings.local_model_id,
                self.safe_url,
                status,
                content_length,
                accept_ranges,
            )
            return check
        finally:
            if owns_client:
                await client.aclose()

    # ---------------------------------------------------------- download --
    def _validate_cached_file(self, path: Path) -> bool:
        """True when an on-disk file can be trusted without re-downloading."""
        try:
            size = path.stat().st_size
        except OSError:
            return False
        if size < self.settings.local_model_min_bytes:
            logger.warning("LOCAL_MODEL_CACHE_REJECTED reason=too_small bytes=%s", size)
            return False
        if not _has_gguf_magic(path):
            logger.warning("LOCAL_MODEL_CACHE_REJECTED reason=not_a_gguf file=%s", path.name)
            return False
        expected_size = self.settings.local_model_expected_size
        if expected_size and size != expected_size:
            logger.warning(
                "LOCAL_MODEL_CACHE_REJECTED reason=size_mismatch bytes=%s expected=%s",
                size,
                expected_size,
            )
            return False
        expected_sha = self.settings.local_model_expected_sha256
        if expected_sha:
            marker = self.verified_marker_path
            try:
                recorded = marker.read_text(encoding="utf-8").strip().lower() if marker.exists() else ""
            except OSError:
                recorded = ""
            if recorded != expected_sha:
                logger.info("LOCAL_MODEL_CACHE_VERIFY file=%s (hashing once)", path.name)
                if _sha256_file(path) != expected_sha:
                    logger.warning("LOCAL_MODEL_CACHE_REJECTED reason=checksum_mismatch")
                    return False
                try:
                    marker.write_text(expected_sha, encoding="utf-8")
                except OSError:
                    pass
        self.file_size_bytes = size
        return True

    async def _download_if_needed(self) -> None:
        path = self.model_path
        if path.exists() and self._validate_cached_file(path):
            logger.info(
                "LOCAL_MODEL_CACHE_HIT file=%s bytes=%s dir=%s (no download)",
                path.name,
                self.file_size_bytes,
                self.model_dir,
            )
            return
        if path.exists():
            # Present but invalid (truncated cold-start, wrong file, corrupt
            # disk). Move it aside rather than loading garbage into llama.cpp.
            try:
                path.replace(path.with_suffix(path.suffix + ".invalid"))
            except OSError:
                try:
                    path.unlink(missing_ok=True)
                except OSError:
                    pass

        try:
            path.parent.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            raise self._source_error(
                reason=f"model cache directory is not writable: {self.model_dir}",
                stage="storage",
                permanent=True,
                hint="Point LOCAL_MODEL_DIR at a writable path (e.g. a Render persistent disk).",
            ) from exc

        self.downloaded_bytes = 0
        part = path.with_suffix(path.suffix + ".part")
        timeout = httpx.Timeout(60.0, read=180.0, connect=15.0)
        attempts = self.settings.local_model_download_retries + 1
        deadline = time.time() + self.settings.local_model_download_timeout
        last_error: ModelSourceError | None = None

        async with httpx.AsyncClient(
            timeout=timeout, follow_redirects=True, max_redirects=5
        ) as client:
            check = await self.preflight(client)  # raises on 404/403/... — no retry
            expected_total = self.settings.local_model_expected_size or check.get("contentLength") or 0
            logger.info(
                "LOCAL_MODEL_DOWNLOAD_START model=%s url=%s bytes=%s dest=%s",
                self.settings.local_model_id,
                self.safe_url,
                expected_total or "unknown",
                path,
            )

            for attempt in range(1, attempts + 1):
                self.download_attempts = attempt
                try:
                    await self._download_once(
                        client,
                        part=part,
                        resume=bool(check.get("acceptRanges")) and attempt > 1,
                        deadline=deadline,
                    )
                    break
                except ModelSourceError as exc:
                    last_error = exc
                    if exc.permanent or attempt >= attempts or time.time() >= deadline:
                        raise
                    backoff = min(30, 2 ** attempt)
                    logger.warning(
                        "LOCAL_MODEL_DOWNLOAD_RETRY attempt=%s/%s reason=%s retry_in_s=%s",
                        attempt,
                        attempts,
                        exc.reason,
                        backoff,
                    )
                    await asyncio.sleep(backoff)
            else:  # pragma: no cover - loop always breaks or raises
                raise last_error or self._source_error(reason="download failed", stage="download")

        self._verify_downloaded_file(part, expected_total=self.settings.local_model_expected_size)
        os.replace(part, path)
        self.file_size_bytes = path.stat().st_size
        expected_sha = self.settings.local_model_expected_sha256
        if expected_sha:
            try:
                self.verified_marker_path.write_text(expected_sha, encoding="utf-8")
            except OSError:
                pass
        logger.info(
            "LOCAL_MODEL_DOWNLOADED file=%s bytes=%s attempts=%s verified=%s",
            path.name,
            self.file_size_bytes,
            self.download_attempts,
            "sha256" if expected_sha else "size+magic",
        )

    async def _download_once(
        self,
        client: httpx.AsyncClient,
        *,
        part: Path,
        resume: bool,
        deadline: float,
    ) -> None:
        url = self.download_url
        headers = {"User-Agent": _USER_AGENT}
        offset = 0
        if resume and part.exists():
            offset = part.stat().st_size
            if offset > 0:
                headers["Range"] = f"bytes={offset}-"
        elif part.exists():
            part.unlink(missing_ok=True)

        try:
            async with client.stream("GET", url, headers=headers) as response:
                if response.status_code >= 400:
                    status = response.status_code
                    raise self._source_error(
                        reason=_HTTP_STATUS_REASONS.get(
                            status, f"model host returned HTTP {status} during download"
                        ),
                        status=status,
                        stage="download",
                        permanent=status in _PERMANENT_HTTP_STATUSES,
                        hint=self._hint_for_status(status),
                    )
                append = response.status_code == 206 and offset > 0
                if not append:
                    offset = 0
                self.downloaded_bytes = offset
                with open(part, "ab" if append else "wb") as handle:
                    async for chunk in response.aiter_bytes(4 * 1024 * 1024):
                        handle.write(chunk)
                        self.downloaded_bytes += len(chunk)
                        if time.time() > deadline:
                            raise self._source_error(
                                reason=(
                                    "model download exceeded LOCAL_MODEL_DOWNLOAD_TIMEOUT "
                                    f"({self.settings.local_model_download_timeout}s)"
                                ),
                                stage="download",
                                hint="Raise LOCAL_MODEL_DOWNLOAD_TIMEOUT or use a smaller quant.",
                            )
        except ModelSourceError:
            raise
        except httpx.HTTPError as exc:
            raise self._source_error(
                reason=f"transport failure while downloading ({exc.__class__.__name__})",
                stage="download",
            ) from exc
        except OSError as exc:
            raise self._source_error(
                reason=f"cannot write model cache file ({exc.__class__.__name__})",
                stage="storage",
                permanent=True,
                hint="Ensure LOCAL_MODEL_DIR has enough free disk and is writable.",
            ) from exc

    def _verify_downloaded_file(self, part: Path, *, expected_total: int) -> None:
        try:
            size = part.stat().st_size
        except OSError as exc:
            raise self._source_error(
                reason="downloaded file disappeared before verification",
                stage="verification",
            ) from exc

        def _fail(reason: str, permanent: bool = False) -> ModelSourceError:
            part.unlink(missing_ok=True)
            return self._source_error(reason=reason, stage="verification", permanent=permanent)

        if size < self.settings.local_model_min_bytes:
            raise _fail(
                f"downloaded file is only {size} bytes — the URL served an error page, not a model",
                permanent=True,
            )
        if expected_total and size != expected_total:
            raise _fail(f"downloaded {size} bytes but expected exactly {expected_total}")
        if not _has_gguf_magic(part):
            raise _fail("downloaded file is not a GGUF model (missing GGUF magic header)", permanent=True)

        expected_sha = self.settings.local_model_expected_sha256
        if expected_sha:
            digest = _sha256_file(part)
            if digest != expected_sha:
                raise _fail("model checksum mismatch (sha256 verification failed)", permanent=True)
            logger.info("LOCAL_MODEL_CHECKSUM_OK sha256=%s…", expected_sha[:12])

    async def _load_model(self) -> None:
        path = self.model_path

        def _load() -> Any:
            try:
                from llama_cpp import Llama  # noqa: PLC0415 — imported lazily on purpose
            except ImportError as exc:
                raise RuntimeError(
                    "llama-cpp-python is not installed; run `pip install -r ai_engine/requirements.txt`"
                ) from exc
            logger.info(
                "LOCAL_MODEL_LOAD_START file=%s bytes=%s ctx=%s threads=%s runtime=%s",
                path.name,
                self.file_size_bytes,
                self.settings.local_model_ctx_size,
                self.settings.local_model_threads,
                runtime_version() or "unknown",
            )
            kwargs: dict[str, Any] = dict(
                model_path=str(path),
                n_ctx=self.settings.local_model_ctx_size,
                n_threads=self.settings.local_model_threads,
                n_threads_batch=self.settings.local_model_threads,
                n_batch=self.settings.local_model_batch,
                n_gpu_layers=0,  # CPU-only deployment
                use_mmap=True,   # mmap keeps RSS reclaimable on small instances
                use_mlock=False,
                logits_all=False,
                embedding=False,
                verbose=False,
            )
            # llama-cpp-python renames/retires constructor kwargs between minor
            # releases (``logits_all`` is the usual casualty). Drop anything the
            # installed runtime does not accept instead of crashing on load.
            try:
                accepted = set(inspect.signature(Llama.__init__).parameters)
                if "kwargs" not in accepted:
                    dropped = [key for key in kwargs if key not in accepted]
                    for key in dropped:
                        kwargs.pop(key)
                    if dropped:
                        logger.info("LOCAL_MODEL_LOAD_KWARGS_DROPPED keys=%s", ",".join(dropped))
            except (TypeError, ValueError):
                pass
            return Llama(**kwargs)

        self._llama = await asyncio.to_thread(_load)

    # --------------------------------------------------------- generation --
    def _render_prompt(self, system_prompt: str, user_prompt: str) -> tuple[str, list[str]]:
        from agent.security import escape_chat_controls
        user_prompt = escape_chat_controls(user_prompt)
        fmt = _CHAT_TEMPLATES.get(self.settings.local_model_chat_format) or _CHAT_TEMPLATES["chatml"]
        return (
            fmt["prompt"].format(system=system_prompt.strip(), user=user_prompt.strip()),
            list(fmt["stops"]),
        )

    @staticmethod
    def _shrink_middle(text: str, target_chars: int) -> str:
        """Drop the middle of a long block, keeping the head and the tail.

        Agent prompts put the task at the top and the freshest tool
        observations at the bottom; both matter more than the middle.
        """
        if len(text) <= target_chars or target_chars < 200:
            return text[:max(0, target_chars)]
        head = int(target_chars * 0.45)
        tail = target_chars - head - 40
        return f"{text[:head]}\n\n…[trimmed to fit the model context]…\n\n{text[-tail:]}"

    def _fit_to_context(
        self,
        llama: Any,
        system_prompt: str,
        user_prompt: str,
        prompt: str,
        max_tokens: int,
    ) -> tuple[str, int]:
        """Guarantee prompt + completion fit in n_ctx.

        Without this, a rich agent turn (system prompt + timetable + syllabus +
        quiz history + web extracts) can exceed the context window and
        llama.cpp raises mid-request, which surfaced to the student as a
        generic "AI model temporarily unavailable". Truncating is honest: the
        model still answers, just from a trimmed context, and the trim is
        logged.
        """
        try:
            n_ctx = int(llama.n_ctx())
        except Exception:
            return prompt, max_tokens

        def _count(text: str) -> int:
            try:
                return len(llama.tokenize(text.encode("utf-8"), add_bos=True, special=True))
            except Exception:
                return len(text) // 3  # conservative fallback estimate

        reserve = 16
        budget = n_ctx - max_tokens - reserve
        if budget < 64:
            # Output request alone is too large for the window: shrink it.
            max_tokens = max(32, n_ctx // 3)
            budget = n_ctx - max_tokens - reserve

        used = _count(prompt)
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
            used = _count(prompt)
            if used <= budget:
                break

        if used > budget:
            # Even an empty user block does not fit: the system prompt itself is
            # oversized. Trade output length for a request that can complete.
            max_tokens = max(32, n_ctx - used - reserve)
            if max_tokens < 32:
                trimmed_system = self._shrink_middle(system_prompt, max(200, budget * 3))
                prompt, _stops = self._render_prompt(trimmed_system, trimmed_user)
                max_tokens = 32

        logger.warning(
            "LOCAL_MODEL_PROMPT_TRUNCATED n_ctx=%s prompt_tokens=%s->%s max_tokens=%s "
            "hint=lower AGENT_MAX_CONTEXT_CHARS or raise LOCAL_MODEL_CTX",
            n_ctx,
            original,
            used,
            max_tokens,
        )
        return prompt, max_tokens

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
        """Single-flight generation; returns raw text. Never fabricates output.

        Readiness is enforced by the supervisor (``inference.manager``); this
        method only refuses to run when no weights are loaded. Once decoding
        starts the model runs to EOS or its token ceiling — there is no
        wall-clock cut and no answer shortening.
        """
        if self._llama is None:
            raise LLMResponseError("Model weights are not loaded", status_code=503, error_type="MODEL_NOT_READY")
        temp = self.settings.llm_temperature if temperature is None else temperature
        bounded_max = max(32, min(int(max_tokens), self.settings.llm_max_output_tokens))

        async with self._gen_lock:
            started = time.monotonic()
            text = ""
            attempts = 1 if allow_empty else 2
            for attempt in range(1, attempts + 1):
                try:
                    # The _llama_thread_lock is acquired INSIDE the thread to
                    # prevent concurrent llama.cpp access even when the asyncio
                    # task is cancelled (asyncio.Lock releases on cancel, but
                    # the thread continues).
                    text = await asyncio.to_thread(
                        self._generate_sync_protected,
                        system_prompt,
                        user_prompt,
                        bounded_max,
                        temp if attempt == 1 else max(temp, 0.4),
                        json_schema,
                        allow_empty,
                        on_token,
                    )
                    break
                except LLMResponseError as exc:
                    if exc.error_type == "invalid_response" and attempt < attempts:
                        logger.info("LOCAL_MODEL_EMPTY_RETRY attempt=%s", attempt)
                        continue
                    raise
            duration_ms = int((time.monotonic() - started) * 1000)
            self.last_inference_at = time.time()
            logger.info(
                "LOCAL_MODEL_GENERATION model=%s max_tokens=%s json=%s duration_ms=%s chars=%s",
                self.settings.local_model_id,
                bounded_max,
                bool(json_schema),
                duration_ms,
                len(text),
            )
            return text

    def _record_throughput(self, tokens: int, seconds: float) -> None:
        """Track real decode speed with an EMA so budgeting self-calibrates.

        Short bursts are ignored: they are dominated by prompt-eval and would
        skew the estimate used to size future budgets.
        """
        if tokens < 8 or seconds <= 0.05:
            return
        observed = tokens / seconds
        if self._tokens_per_second is None:
            self._tokens_per_second = observed
        else:
            self._tokens_per_second = (0.7 * self._tokens_per_second) + (0.3 * observed)

    def _generate_sync_protected(
        self,
        system_prompt: str,
        user_prompt: str,
        max_tokens: int,
        temperature: float,
        json_schema: dict[str, Any] | None,
        allow_empty: bool = False,
        on_token: Any = None,
    ) -> str:
        """Thread-safe wrapper around _generate_sync.

        Acquires the threading-level lock so that even if an asyncio task is
        cancelled (releasing the asyncio.Lock), a new thread cannot start a
        concurrent llama.cpp call while the previous one is still running.
        """
        # Generation is single-flight. A bounded queue wait protects the
        # service from abandoned clients without ever cutting an answer that
        # has already started decoding.
        acquired = self._llama_thread_lock.acquire(timeout=300.0)
        if not acquired:
            raise LLMResponseError(
                "The local model is busy processing another request. Please try again.",
                status_code=503,
                error_type="model_busy",
            )
        try:
            return self._generate_sync(
                system_prompt, user_prompt, max_tokens,
                temperature, json_schema, allow_empty, on_token,
            )
        finally:
            self._llama_thread_lock.release()

    def _generate_sync(
        self,
        system_prompt: str,
        user_prompt: str,
        max_tokens: int,
        temperature: float,
        json_schema: dict[str, Any] | None,
        allow_empty: bool = False,
        on_token: Any = None,
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
        prompt, max_tokens = self._fit_to_context(llama, system_prompt, user_prompt, prompt, max_tokens)
        inference_started = time.monotonic()
        first_token_ms: int | None = None
        pieces: list[str] = []
        finish_reason = None

        try:
            # Ask llama.cpp for its genuine token iterator. Even callers that
            # consume a final response benefit: this records true first-token
            # latency rather than estimating it from total generation time.
            chunks = llama.create_completion(
                prompt=prompt,
                max_tokens=max_tokens,
                temperature=temperature,
                top_p=0.9,
                top_k=40,
                repeat_penalty=1.1,
                stop=stops,
                grammar=grammar,
                echo=False,
                stream=True,
            )
            # Test doubles and older compatible runtimes may ignore stream=True
            # and return the traditional aggregate dictionary.
            chunks_iter = [chunks] if isinstance(chunks, dict) else chunks
            for chunk in chunks_iter:
                choices = chunk.get("choices", []) if isinstance(chunk, dict) else []
                piece = str(choices[0].get("text", "") or "") if choices else ""
                if choices and choices[0].get("finish_reason"):
                    finish_reason = choices[0]["finish_reason"]
                if piece:
                    if first_token_ms is None:
                        first_token_ms = int((time.monotonic() - inference_started) * 1000)
                        logger.info("[EduNova AI] First token latency_ms=%s", first_token_ms)
                    pieces.append(piece)
                    if on_token is not None:
                        on_token(piece)
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
        generation_seconds = max(0.001, time.monotonic() - inference_started)
        try:
            generated_tokens = len(llama.tokenize(text.encode("utf-8"), add_bos=False, special=True))
        except Exception:
            generated_tokens = max(0, len(text) // 3)
        self._record_throughput(generated_tokens, generation_seconds)
        self.last_generation_metrics = {
            "tokens": generated_tokens,
            "finishReason": finish_reason,
            "durationMs": int(generation_seconds * 1000),
            "tokensPerSecond": round(generated_tokens / generation_seconds, 2),
            "firstTokenMs": first_token_ms,
            "responseChars": len(text),
        }
        logger.info(
            "[EduNova AI] Inference completed tokens=%s duration_ms=%s tokens_per_second=%.2f first_token_ms=%s",
            generated_tokens,
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
