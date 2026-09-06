"""THE authoritative model lifecycle for the EduNova AI INFERENCE service.

This module runs ONLY inside the persistent inference service
(``inference_server.py``). The lightweight orchestrator (``main.py``) never
imports it and never loads a model; it talks to the inference service over an
authenticated HTTP/SSE API.

Lifecycle (once, at service start — never per request):

    BOOT -> CONFIG_LOADED -> RESOURCES_CHECKED -> DEPENDENCIES_READY
         -> MODEL_LOCATED -> MODEL_VALID -> MODEL_LOADING -> MODEL_LOADED
         -> WARMUP_RUNNING -> WARMUP_SUCCESS -> INFERENCE_TEST_SUCCESS -> READY

Terminal failures are explicit and permanent for the life of the process
(operator action is required): MODEL_RESOURCE_INSUFFICIENT, CONFIG_FAILED,
DEPENDENCY_FAILED, MODEL_NOT_FOUND, MODEL_INVALID, MODEL_DOWNLOAD_FAILED,
MODEL_LOAD_FAILED, OUT_OF_MEMORY, WARMUP_FAILED, INFERENCE_FAILED.

The weights live in a supervised child process: native llama.cpp calls cannot
be interrupted from asyncio, so the parent can terminate a stalled worker
without wedging the event loop. Memory is checked BEFORE the worker is
spawned; there is no retry loop and no infinite WARMING state.
"""
from __future__ import annotations

import asyncio
import logging
import multiprocessing as mp
from pathlib import Path
import re
import time
from typing import Any

from agent.llm import LLMResponseError
from config import Settings
from inference.resources import ResourceInsufficient, ResourceManager, check_model_fits, estimate_requirement

log = logging.getLogger("edunova.model_manager")

PHASES = {
    "BOOT": (30, "Worker started", "CONFIG_FAILED"),
    "CONFIG_LOADED": (30, "Valid local runtime/model configuration", "CONFIG_FAILED"),
    "RESOURCES_CHECKED": (30, "Container memory proven sufficient", "MODEL_RESOURCE_INSUFFICIENT"),
    "DEPENDENCIES_READY": (30, "llama.cpp runtime import completed", "DEPENDENCY_FAILED"),
    "RUNTIME_READY": (1800, "Model located (cache hit) or downloaded once", "MODEL_DOWNLOAD_FAILED"),
    "MODEL_LOCATED": (120, "Integrity (size/sha256/GGUF magic) validated", "MODEL_INVALID"),
    "MODEL_VALID": (10, "Load scheduled", "MODEL_LOAD_FAILED"),
    "MODEL_LOADING": (180, "Weights and tokenizer mmapped", "MODEL_LOAD_FAILED"),
    "MODEL_LOADED": (10, "Warmup started", "WARMUP_FAILED"),
    "WARMUP_RUNNING": (120, "Real decoded tokens for 'What is 2 + 2?'", "WARMUP_FAILED"),
    "WARMUP_SUCCESS": (120, "Independent inference test passed", "INFERENCE_FAILED"),
    "INFERENCE_TEST_SUCCESS": (10, "Readiness published", "INFERENCE_FAILED"),
    "READY": (None, "Accept inference", "INFERENCE_FAILED"),
    "SERVING": (None, "EOS / validated completion", "INFERENCE_FAILED"),
}
FAILURES = {
    "CONFIG_FAILED", "DEPENDENCY_FAILED", "RUNTIME_FAILED", "MODEL_NOT_FOUND",
    "MODEL_INVALID", "MODEL_DOWNLOAD_FAILED", "MODEL_LOAD_FAILED", "OUT_OF_MEMORY",
    "MODEL_RESOURCE_INSUFFICIENT", "WARMUP_FAILED", "INFERENCE_FAILED",
}
# Public state names (requirement 15): MODEL_NOT_READY / MODEL_LOADING / MODEL_READY / MODEL_FAILED.
PUBLIC_STATES = {"BOOT": "MODEL_NOT_READY", "READY": "MODEL_READY", "SERVING": "MODEL_READY"}


def public_state(phase: str) -> str:
    if phase in FAILURES:
        return "MODEL_FAILED"
    return PUBLIC_STATES.get(phase, "MODEL_LOADING")


def safe_error(exc: Any) -> str:
    # Do not expose credentials in exception URLs, signed queries or DSNs.
    text = str(exc)
    text = re.sub(r"(?:https?|mongodb(?:\+srv)?)://\S+", "[endpoint redacted]", text)
    text = re.sub(r"(?i)(token|password|api[_-]?key|authorization)\s*[=:]\s*\S+", r"\1=[redacted]", text)
    return text[:600]


def resources() -> dict[str, Any]:
    """Compatibility wrapper (older callers/tests) around ResourceManager."""
    snap = ResourceManager().snapshot()
    rss = None
    try:
        for line in Path("/proc/self/status").read_text().splitlines():
            if line.startswith("VmRSS:"):
                rss = int(line.split()[1]) * 1024
    except (OSError, ValueError):
        pass
    limit_mb = snap.get("ram_limit_mb") or snap.get("ram_total_mb")
    return {"memoryLimitBytes": (limit_mb * 1024 * 1024) if limit_mb else None,
            "cpuQuotaCores": snap.get("cpu_quota_cores"), "visibleCpuCount": snap.get("cpu_cores"),
            "rssBytes": rss, "python": snap.get("python"), "os": snap.get("os"),
            "architecture": snap.get("architecture"), **snap}


def model_requirement(settings: Settings, model_path: Path | None = None) -> dict[str, Any]:
    """Memory requirement of the configured model (GGUF header when the file exists)."""
    entry = settings.local_model_known_entry or {}
    return estimate_requirement(
        runtime="llama_cpp",
        model_path=model_path if (model_path and model_path.exists()) else None,
        ctx=settings.local_model_ctx_size,
        catalogue_ram_mb=int(entry.get("ram_mb", 0) or 0),
        expected_bytes=settings.local_model_expected_size,
        with_embeddings=bool(settings.rag_enabled and settings.rag_embedding_model != "lexical"),
    )


def preflight_resources(settings: Settings, model_path: Path | None = None) -> dict[str, Any]:
    """Parent-side check executed BEFORE the worker is spawned. Raises ResourceInsufficient."""
    requirement = model_requirement(settings, model_path)
    snapshot = ResourceManager(settings.local_model_dir).snapshot()
    return check_model_fits(requirement, snapshot)


def _worker(connection, settings: Settings) -> None:
    """Child entry point. Only trusted parent commands arrive over the pipe."""
    logging.getLogger("httpx").setLevel(logging.WARNING)
    phase = "BOOT"
    state: dict[str, Any] = {"runtimeAvailable": False, "modelLoaded": False,
                             "tokenizerLoaded": False, "warmupComplete": False,
                             "inferenceTest": False}

    def emit(new_phase: str, **facts):
        nonlocal phase
        phase = new_phase
        state.update(facts)
        connection.send({"kind": "state", "phase": phase, "facts": dict(state)})

    async def run():
        emit("BOOT", resources=resources())
        if settings.llm_provider != "local":
            raise ValueError("Only self-hosted inference is supported (LLM_PROVIDER=local)")
        if settings.llm_configuration_error:
            raise ValueError(f"Invalid model configuration: {settings.llm_configuration_error}")
        emit("CONFIG_LOADED")

        from agent.local_llm import LocalModelManager, ModelSourceError
        manager = LocalModelManager(settings)
        # Second (in-worker) resource check with the real file when cached.
        requirement = model_requirement(settings, manager.model_path)
        try:
            check_model_fits(requirement, ResourceManager(settings.local_model_dir).snapshot())
        except ResourceInsufficient as exc:
            state["resourceReport"] = exc.report()
            raise
        emit("RESOURCES_CHECKED", memoryRequirement=requirement)

        import llama_cpp
        emit("DEPENDENCIES_READY", runtimeVersion=llama_cpp.__version__, runtimeAvailable=True)

        try:
            await manager._download_if_needed()
        except ModelSourceError as exc:
            # Only a proven 404 for an invalid same-repository override can use
            # its checksum-pinned catalogue file. Never another provider.
            if not manager._try_recover_invalid_override(exc):
                raise
            await manager._download_if_needed()
            state["configOverrideRejected"] = manager.config_override_rejected
            state["effectiveModelId"] = manager.settings.local_model_id
        # Download bookkeeping surfaces in the parent snapshot so /model/status
        # and the startup tests can prove a real transfer happened (or prove
        # the cache was reused) without trusting any client-side claim.
        emit("RUNTIME_READY", downloadAttempts=manager.download_attempts,
             downloadedBytes=manager.downloaded_bytes or None,
             fileSizeBytes=manager.file_size_bytes or None)
        emit("MODEL_LOCATED", fileExists=manager.model_path.exists(), fileName=manager.model_path.name)
        if not await asyncio.to_thread(manager._validate_cached_file, manager.model_path):
            raise ValueError("GGUF integrity validation failed (size/sha256/magic)")
        # Re-estimate with the real header now that the file is proven valid.
        requirement = model_requirement(settings, manager.model_path)
        check_model_fits(requirement, ResourceManager(settings.local_model_dir).snapshot())
        emit("MODEL_VALID", fileValid=True, fileSizeBytes=manager.file_size_bytes,
             memoryRequirement=requirement, quantization=requirement.get("quantization"))

        emit("MODEL_LOADING")
        started = time.monotonic()
        await manager._load_model()
        emit("MODEL_LOADED", modelLoaded=True, tokenizerLoaded=True,
             modelLoadMs=round((time.monotonic() - started) * 1000))

        emit("WARMUP_RUNNING")
        started = time.monotonic()
        answer = await manager.generate(system_prompt="Answer briefly.", user_prompt="What is 2 + 2?",
                                        max_tokens=24, temperature=0)
        if not answer.strip() or not (manager.last_generation_metrics or {}).get("tokens"):
            raise ValueError("Warmup did not generate decoded tokens")
        warmup = {"ok": True, "prompt": "What is 2 + 2?", "answer": answer,
                  "durationMs": round((time.monotonic() - started) * 1000),
                  "generation": manager.last_generation_metrics}
        emit("WARMUP_SUCCESS", warmupComplete=True, warmupMs=warmup["durationMs"], lastSelfTest=warmup)

        answer = await manager.generate(system_prompt="Answer briefly.",
                                        user_prompt="Name one thing students can learn.",
                                        max_tokens=32, temperature=0)
        if not answer.strip() or not (manager.last_generation_metrics or {}).get("tokens"):
            raise ValueError("Independent inference test returned no decoded tokens")
        emit("INFERENCE_TEST_SUCCESS", inferenceTest=True)
        emit("READY", resources=resources())

        while True:
            command = await asyncio.to_thread(connection.recv)
            if command["kind"] == "stop":
                return
            if command["kind"] == "cancel":
                continue
            try:
                emit("SERVING")

                def on_token(piece):
                    if connection.poll():
                        control = connection.recv()
                        if control.get("kind") in {"cancel", "stop"}:
                            raise LLMResponseError("Generation cancelled", status_code=499, error_type="REQUEST_CANCELLED")
                    connection.send({"kind": "token", "delta": piece})

                text = await manager.generate(**command["arguments"], on_token=on_token)
                if (manager.last_generation_metrics or {}).get("finishReason") == "length":
                    raise LLMResponseError(
                        "The model reached its output token capacity before finishing; partial output is not a complete answer",
                        status_code=502, error_type="OUTPUT_LIMIT_REACHED")
                connection.send({"kind": "result", "text": text, "metrics": manager.last_generation_metrics})
                emit("READY", resources=resources())
            except Exception as exc:  # noqa: BLE001 — reported, never faked
                connection.send({"kind": "error", "code": getattr(exc, "error_type", "INFERENCE_FAILED"),
                                 "message": safe_error(exc), "metrics": manager.last_generation_metrics})
                # Invalid model output does not justify reloading the weights.
                emit("READY")

    try:
        asyncio.run(run())
    except (EOFError, BrokenPipeError):
        pass
    except Exception as exc:  # noqa: BLE001
        failure = {
            "BOOT": "CONFIG_FAILED", "CONFIG_LOADED": "MODEL_RESOURCE_INSUFFICIENT",
            "RESOURCES_CHECKED": "DEPENDENCY_FAILED", "DEPENDENCIES_READY": "MODEL_DOWNLOAD_FAILED",
            "RUNTIME_READY": "MODEL_INVALID", "MODEL_LOCATED": "MODEL_INVALID",
            "MODEL_VALID": "MODEL_LOAD_FAILED", "MODEL_LOADING": "MODEL_LOAD_FAILED",
            "MODEL_LOADED": "WARMUP_FAILED", "WARMUP_RUNNING": "WARMUP_FAILED",
            "WARMUP_SUCCESS": "INFERENCE_FAILED",
        }.get(phase, "INFERENCE_FAILED")
        if isinstance(exc, ResourceInsufficient):
            failure = "MODEL_RESOURCE_INSUFFICIENT"
            state["resourceReport"] = exc.report()
        elif isinstance(exc, MemoryError):
            failure = "OUT_OF_MEMORY"
        elif isinstance(exc, FileNotFoundError) or getattr(exc, "status", None) == 404:
            failure = "MODEL_NOT_FOUND"
        emit(failure, lastError=safe_error(exc), failureStage=phase)
    finally:
        connection.close()


class ModelManager:
    """Parent-side supervisor. Exactly one instance per inference service process."""

    def __init__(self, settings: Settings, *, worker_target=_worker):
        self.settings = settings
        self.worker_target = worker_target
        self.phase = "BOOT"
        self.state = "not_started"  # compatibility only; phase is authoritative
        self.started_at = None
        self.ready_at = None
        self.last_error = ""
        self.error_detail = ""
        self.error_report = None
        self.last_generation_metrics = None
        self.last_self_test = None
        self.history = []
        self.facts: dict[str, Any] = {}
        self._process = None
        self._pipe = None
        self._load_task = None
        self._generation_lock = asyncio.Lock()
        self._started = False
        self._ready_event = asyncio.Event()
        self._current = None
        self._callback = None
        self._last_activity = time.monotonic()
        self._phase_entered = self._last_activity
        self._boot_monotonic = self._last_activity
        self._startup_duration_ms = None

    # ------------------------------------------------------------ status --
    @property
    def config_override_rejected(self):
        return self.facts.get("configOverrideRejected")

    @property
    def public_state(self) -> str:
        return public_state(self.phase)

    def _transition(self, phase, facts=None):
        if phase not in PHASES and phase not in FAILURES:
            raise ValueError("Unknown model lifecycle state")
        self.phase = phase
        self._phase_entered = time.monotonic()
        self.facts.update(facts or {})
        timeout, success, failure = PHASES.get(phase, (0, "Service restart required", "Terminal failure"))
        self.history.append({"state": phase, "timestamp": time.time(), "timeoutSeconds": timeout,
                             "successCondition": success, "failureCondition": failure,
                             "diagnostic": safe_error(self.facts.get("lastError", ""))})
        self.history = self.history[-64:]
        self.state = "ready" if phase in {"READY", "SERVING"} else "error" if phase in FAILURES else "loading"
        if phase == "RUNTIME_READY":
            self.state = "downloading"
        if phase in {"WARMUP_RUNNING", "WARMUP_SUCCESS"}:
            self.state = "warming"
        if phase in FAILURES:
            if self._startup_duration_ms is None:
                self._startup_duration_ms = round((time.monotonic() - self._boot_monotonic) * 1000)
            self.last_error = self.facts.get("lastError", phase)
            self.error_detail = phase
            self.error_report = {"code": phase if phase == "MODEL_RESOURCE_INSUFFICIENT" else
                                 ("MODEL_STARTUP_FAILED" if self.ready_at is None else "INFERENCE_FAILED"),
                                 "stage": phase, "reason": self.last_error, "permanent": True}
            if self.facts.get("resourceReport"):
                self.error_report.update(self.facts["resourceReport"])
            self._ready_event.set()
        if phase == "READY":
            if self.ready_at is None:
                self.ready_at = time.time()
                self.facts["coldStartMs"] = round((time.monotonic() - self._boot_monotonic) * 1000)
                self._startup_duration_ms = self.facts["coldStartMs"]
            self._ready_event.set()
        log.info("MODEL_STATE state=%s public=%s diagnostic=%s", phase, public_state(phase), self.last_error or "-")

    # ------------------------------------------------------------ startup --
    def ensure_loading(self, force=False):
        """Start the single lifecycle once. Never restarts a failed/ready model."""
        if self._started or self.phase in FAILURES:
            return
        self._started = True
        self.started_at = time.time()
        self._boot_monotonic = time.monotonic()
        self._transition("BOOT")
        # Memory rule: NEVER spawn a worker for a model the container cannot hold.
        try:
            from agent.local_llm import LocalModelManager
            check = preflight_resources(self.settings, LocalModelManager(self.settings).model_path)
            self.facts["memoryRequirement"] = {k: v for k, v in check.items() if k != "fits"}
        except ResourceInsufficient as exc:
            self.facts["resourceReport"] = exc.report()
            self._transition("MODEL_RESOURCE_INSUFFICIENT", {"lastError": safe_error(exc), "failureStage": "BOOT"})
            log.error("MODEL_RESOURCE_INSUFFICIENT required_mb=%s available_mb=%s recommended_mb=%s",
                      exc.required_mb, exc.available_mb, exc.recommended_mb)
            return
        except Exception as exc:  # noqa: BLE001 — detection failure is a config failure, not a crash
            self._transition("CONFIG_FAILED", {"lastError": safe_error(exc), "failureStage": "BOOT"})
            return
        context = mp.get_context("spawn")
        self._pipe, child = context.Pipe()
        self._process = context.Process(target=self.worker_target, args=(child, self.settings), daemon=True)
        self._process.start()
        child.close()
        self._load_task = asyncio.create_task(self._monitor())

    async def _terminate(self):
        if self._process is not None and self._process.is_alive():
            self._process.terminate()
            await asyncio.to_thread(self._process.join, 2)
            if self._process.is_alive():
                self._process.kill()
                await asyncio.to_thread(self._process.join, 2)

    async def _fail(self, code, message):
        self._transition(code, {"lastError": message})
        if self._current and not self._current.done():
            self._current.set_exception(LLMResponseError(message, status_code=503, error_type=code))
        await self._terminate()

    async def _monitor(self):
        try:
            while self.phase not in FAILURES:
                while self._pipe.poll():
                    event = self._pipe.recv()
                    self._last_activity = time.monotonic()
                    kind = event.get("kind")
                    if kind == "state":
                        self._transition(event["phase"], event.get("facts"))
                        self.last_self_test = self.facts.get("lastSelfTest")
                    elif kind == "token" and self._callback:
                        try:
                            self._callback(event["delta"])
                        except Exception:  # noqa: BLE001
                            # Stop decoding for a broken consumer without killing
                            # the persistent model. Keep admission locked until ack.
                            self._callback = None
                            self._pipe.send({"kind": "cancel"})
                    elif kind in {"result", "error"} and self._current and not self._current.done():
                        self.last_generation_metrics = event.get("metrics")
                        if kind == "result":
                            self._current.set_result(event["text"])
                        else:
                            self._current.set_exception(LLMResponseError(event["message"], status_code=502, error_type=event["code"]))
                now = time.monotonic()
                if self.ready_at is None:
                    stage_timeout = PHASES.get(self.phase, (0,))[0] or 0
                    if now - self._boot_monotonic > self.settings.local_model_startup_timeout or (stage_timeout and now - self._phase_entered > stage_timeout):
                        stage = self.phase
                        code = PHASES.get(stage, (0, "", "RUNTIME_FAILED"))[2]
                        if code not in FAILURES:
                            code = "RUNTIME_FAILED"
                        await self._fail(code, f"MODEL_STARTUP_FAILED: hard deadline exceeded in {stage} "
                                               f"(startup budget {self.settings.local_model_startup_timeout}s)")
                        break
                elif self._current and not self._current.done() and now - self._last_activity > self.settings.local_inference_idle_timeout:
                    await self._fail("INFERENCE_FAILED", "Native inference stalled (no decoded tokens within idle deadline)")
                    break
                if not self._process.is_alive() and self.phase not in FAILURES:
                    await self._fail("OUT_OF_MEMORY" if self._process.exitcode == -9 else "RUNTIME_FAILED",
                                     f"Model worker exited unexpectedly (exit={self._process.exitcode})")
                    break
                await asyncio.sleep(0.01)
        except (EOFError, OSError) as exc:
            if self.phase not in FAILURES:
                await asyncio.to_thread(self._process.join, 0.2)
                code = "OUT_OF_MEMORY" if self._process.exitcode == -9 else "RUNTIME_FAILED"
                await self._fail(code, f"Worker connection closed (exit={self._process.exitcode}): {safe_error(exc)}")
        except Exception as exc:  # noqa: BLE001
            await self._fail("RUNTIME_FAILED", f"Supervisor failure: {safe_error(exc)}")
        finally:
            if self.phase in FAILURES and self._current and not self._current.done():
                self._current.set_exception(LLMResponseError(self.last_error, status_code=503, error_type=self.phase))

    # ---------------------------------------------------------- inference --
    def is_ready(self):
        return bool(self.phase in {"READY", "SERVING"} and self.facts.get("inferenceTest")
                    and self.facts.get("warmupComplete") and self._process and self._process.is_alive())

    async def wait_ready(self, timeout=0):
        # Observational: no download, retry, loading or implicit queueing.
        if self.is_ready():
            return
        raise LLMResponseError(self.last_error or f"Model startup has not completed ({self.public_state}: {self.phase})",
                               status_code=503, error_type=self.error_detail or "MODEL_NOT_READY")

    async def generate(self, *, on_token=None, **arguments):
        await self.wait_ready()
        # Bounded admission, NOT an output timer. Reject concurrent work instead
        # of consuming unbounded RAM on hundreds of queued requests.
        if self._generation_lock.locked():
            raise LLMResponseError("Inference capacity is busy", status_code=429, error_type="MODEL_BUSY")
        async with self._generation_lock:
            self._current = asyncio.get_running_loop().create_future()
            self._callback = on_token
            self._last_activity = time.monotonic()
            self._pipe.send({"kind": "generate", "arguments": arguments})
            try:
                return await asyncio.shield(self._current)
            except asyncio.CancelledError:
                # Ask the worker to stop at the next token boundary. Shield the
                # result so cancellation does not release the KV-cache lock early.
                self._callback = None
                self._pipe.send({"kind": "cancel"})
                try:
                    await asyncio.wait_for(asyncio.shield(self._current), self.settings.local_inference_idle_timeout)
                except asyncio.TimeoutError:
                    await self._fail("INFERENCE_FAILED", "Cancelled native inference did not stop")
                except LLMResponseError:
                    pass
                raise
            finally:
                self._current = None
                self._callback = None

    async def self_test(self):
        text = await self.generate(system_prompt="Answer briefly.", user_prompt="What is 2 + 2?", max_tokens=24)
        return {"ok": bool(text.strip()), "answer": text, "generation": self.last_generation_metrics}

    def snapshot(self, include_source=False):
        snap = {**self.facts, "state": self.state, "publicState": self.public_state,
                "lifecycle": self.phase, "phase": self.phase, "runtime": "llama_cpp",
                "modelId": self.facts.get("effectiveModelId", self.settings.local_model_id),
                "ready": self.is_ready(), "inferenceAvailable": self.is_ready(),
                "lastError": self.last_error or None, "errorDetail": self.error_detail or None,
                "lastGeneration": self.last_generation_metrics, "lastSelfTest": self.last_self_test,
                "contextSize": self.settings.local_model_ctx_size, "threads": self.settings.local_model_threads,
                "loadedAt": self.ready_at,
                "startupDurationMs": self._startup_duration_ms if self._startup_duration_ms is not None else (
                    round((time.monotonic() - self._boot_monotonic) * 1000) if self._started else None),
                "startupTimeoutSeconds": self.settings.local_model_startup_timeout,
                "history": list(self.history), "permanentFailure": self.phase in FAILURES,
                "overrideRejected": bool(self.facts.get("configOverrideRejected"))}
        if include_source:
            snap["errorReport"] = self.error_report
        return snap

    async def close(self):
        await self._terminate()
        if self._load_task and not self._load_task.done():
            self._load_task.cancel()
            await asyncio.gather(self._load_task, return_exceptions=True)
        if self._pipe:
            self._pipe.close()
