"""Persistent, process-isolated ModelManager. HTTP requests NEVER start models.

Native C/C++ and torch calls cannot be stopped by cancelling an asyncio thread.
A supervised child owns the weights; the parent can terminate it on a startup
or stalled-inference deadline without wedging FastAPI's event loop. There is
one child and one generation at a time, not one model per request.
"""
from __future__ import annotations

import asyncio
from dataclasses import replace
import importlib.metadata
import logging
import multiprocessing as mp
import os
from pathlib import Path
import platform
import re
import time
from typing import Any

from agent.llm import LLMResponseError
from config import Settings

log = logging.getLogger("edunova.model_manager")

PHASES = {
    "BOOT": (30, "Worker started", "Worker failed to start"),
    "CONFIG_LOADED": (30, "Valid local runtime/model configuration", "CONFIG_FAILED"),
    "DEPENDENCIES_READY": (30, "Runtime import completed", "DEPENDENCY_FAILED"),
    "RUNTIME_READY": (180, "Model located/downloaded", "MODEL_DOWNLOAD_FAILED"),
    "MODEL_LOCATED": (60, "Integrity and format validated", "MODEL_INVALID"),
    "MODEL_VALID": (10, "Load scheduled", "MODEL_LOAD_FAILED"),
    "MODEL_LOADING": (120, "Weights and tokenizer loaded", "MODEL_LOAD_FAILED"),
    "MODEL_LOADED": (10, "Warmup started", "WARMUP_FAILED"),
    "WARMUP_RUNNING": (60, "Non-empty decoded inference output", "WARMUP_FAILED"),
    "WARMUP_SUCCESS": (60, "Independent inference test passed", "INFERENCE_FAILED"),
    "INFERENCE_TEST_SUCCESS": (10, "Readiness published", "INFERENCE_FAILED"),
    "READY": (None, "Accept inference", "INFERENCE_FAILED"),
    "SERVING": (None, "EOS / validated completion", "INFERENCE_FAILED"),
}
FAILURES = {
    "CONFIG_FAILED", "DEPENDENCY_FAILED", "RUNTIME_FAILED", "MODEL_NOT_FOUND",
    "MODEL_INVALID", "MODEL_DOWNLOAD_FAILED", "MODEL_LOAD_FAILED", "OUT_OF_MEMORY",
    "WARMUP_FAILED", "INFERENCE_FAILED",
}


def safe_error(exc: Any) -> str:
    # Do not expose credentials in exception URLs, signed queries or DSNs.
    text = str(exc)
    text = re.sub(r"(?:https?|mongodb(?:\+srv)?)://\S+", "[endpoint redacted]", text)
    text = re.sub(r"(?i)(token|password|api[_-]?key|authorization)\s*[=:]\s*\S+", r"\1=[redacted]", text)
    return text[:500]


def resources() -> dict[str, Any]:
    memory = None
    cpu = None
    for file in ("/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory/memory.limit_in_bytes"):
        try:
            value = int(Path(file).read_text().strip())
            if value < 2**60:
                memory = value
                break
        except (OSError, ValueError):
            pass
    if memory is None:
        try:
            memory = os.sysconf("SC_PHYS_PAGES") * os.sysconf("SC_PAGE_SIZE")
        except (ValueError, OSError, AttributeError):
            pass
    try:
        quota, period = Path("/sys/fs/cgroup/cpu.max").read_text().split()
        if quota != "max":
            cpu = int(quota) / int(period)
    except (OSError, ValueError):
        pass
    try:
        available_cpus = len(os.sched_getaffinity(0))
    except AttributeError:
        available_cpus = os.cpu_count() or 1
    rss = None
    try:
        for line in Path("/proc/self/status").read_text().splitlines():
            if line.startswith("VmRSS:"):
                rss = int(line.split()[1]) * 1024
    except (OSError, ValueError):
        pass
    return {"memoryLimitBytes": memory, "cpuQuotaCores": cpu,
            "visibleCpuCount": available_cpus, "rssBytes": rss,
            "python": platform.python_version(), "os": platform.system(),
            "architecture": platform.machine()}


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
            raise ValueError("Only self-hosted inference is supported")
        if settings.llm_configuration_error:
            raise ValueError(settings.llm_configuration_error)
        if settings.local_model_runtime == "torch" and (
            settings.local_model_file.lower().endswith(".gguf") or settings.local_model_repo.upper().endswith("-GGUF")
        ):
            raise ValueError("GGUF weights require LOCAL_MODEL_RUNTIME=llama_cpp")
        emit("CONFIG_LOADED")
        if settings.local_model_runtime == "llama_cpp":
            import llama_cpp
            from agent.local_llm import LocalModelManager
            manager = LocalModelManager(settings)
            version = llama_cpp.__version__
        elif settings.local_model_runtime == "torch":
            import torch
            from inference.torch_runtime import TorchModelManager
            manager = TorchModelManager(settings)
            version = torch.__version__
        else:
            raise ValueError("Unsupported local runtime")
        emit("DEPENDENCIES_READY", runtimeVersion=version, runtimeAvailable=True, resources=resources())
        capacity = resources()
        # Estimates include the API/embedding process as well as native weights.
        required_mb = (settings.local_model_estimated_ram_mb or 700) + 400
        if settings.local_model_runtime == "torch":
            required_mb = max(required_mb, 2048)
        if capacity["memoryLimitBytes"] and capacity["memoryLimitBytes"] < required_mb * 1024**2:
            raise MemoryError(f"Model + server ML need at least {required_mb} MiB; container has {capacity['memoryLimitBytes'] // 1024**2} MiB")
        emit("RUNTIME_READY", resources=capacity)
        if settings.local_model_runtime == "llama_cpp":
            from agent.local_llm import ModelSourceError
            try:
                await manager._download_if_needed()
            except ModelSourceError as exc:
                # Only a proven 404 for an invalid same-repository override can
                # use its checksum-pinned catalogue file. Never another provider.
                if not manager._try_recover_invalid_override(exc):
                    raise
                await manager._download_if_needed()
                emit("RUNTIME_READY", configOverrideRejected=manager.config_override_rejected,
                     effectiveModelId=manager.settings.local_model_id)
        else:
            await manager._obtain_weights()
        emit("MODEL_LOCATED", fileExists=manager.model_path.exists(), fileName=manager.model_path.name)
        if settings.local_model_runtime == "llama_cpp":
            if not await asyncio.to_thread(manager._validate_cached_file, manager.model_path):
                raise ValueError("GGUF integrity validation failed")
        else:
            if not (manager.model_path / "config.json").exists() or not list(manager.model_path.glob("*.safetensors")):
                raise ValueError("Transformers runtime requires config.json and safetensors weights (pickle checkpoints are not accepted)")
        emit("MODEL_VALID", fileValid=True, fileSizeBytes=getattr(manager, "file_size_bytes", None))
        emit("MODEL_LOADING")
        started = time.monotonic()
        await manager._load_model()
        if settings.local_model_runtime == "torch":
            await asyncio.to_thread(manager._configure_quantization_and_compile)
        emit("MODEL_LOADED", modelLoaded=True, tokenizerLoaded=True,
             modelLoadMs=round((time.monotonic() - started) * 1000))
        manager.state = "warming"
        emit("WARMUP_RUNNING")
        started = time.monotonic()
        args = {"_skip_wait_ready": True} if settings.local_model_runtime == "llama_cpp" else {}
        answer = await manager.generate(system_prompt="Answer briefly.", user_prompt="What is 2 + 2?",
                                        max_tokens=16, temperature=0, **args)
        if not answer.strip() or not (manager.last_generation_metrics or {}).get("tokens"):
            raise ValueError("Warmup did not generate decoded tokens")
        # This verifies runtime operation, not general reasoning quality.
        warmup = {"ok": True, "answer": answer, "durationMs": round((time.monotonic() - started) * 1000)}
        emit("WARMUP_SUCCESS", warmupComplete=True, warmupMs=warmup["durationMs"], lastSelfTest=warmup)
        answer = await manager.generate(system_prompt="Answer briefly.", user_prompt="Name one thing students can learn.",
                                        max_tokens=24, temperature=0, **args)
        if not answer.strip() or not (manager.last_generation_metrics or {}).get("tokens"):
            raise ValueError("Independent inference test returned no decoded tokens")
        emit("INFERENCE_TEST_SUCCESS", inferenceTest=True)
        manager.last_self_test = warmup
        manager.state = "ready"
        if settings.local_model_runtime == "torch":
            manager._ready = True
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
                    raise LLMResponseError("The model reached its output capacity before finishing; partial output is not a complete answer", status_code=502, error_type="OUTPUT_LIMIT_REACHED")
                connection.send({"kind": "result", "text": text, "metrics": manager.last_generation_metrics})
                emit("READY", resources=resources())
            except Exception as exc:
                connection.send({"kind": "error", "code": getattr(exc, "error_type", "INFERENCE_FAILED"), "message": safe_error(exc), "metrics": manager.last_generation_metrics})
                # Invalid model output does not justify reloading the weights.
                emit("READY")

    try:
        asyncio.run(run())
    except (EOFError, BrokenPipeError):
        pass
    except Exception as exc:
        failure = {
            "BOOT": "CONFIG_FAILED", "CONFIG_LOADED": "DEPENDENCY_FAILED",
            "DEPENDENCIES_READY": "RUNTIME_FAILED", "RUNTIME_READY": "MODEL_DOWNLOAD_FAILED",
            "MODEL_LOCATED": "MODEL_INVALID", "MODEL_VALID": "MODEL_LOAD_FAILED",
            "MODEL_LOADING": "MODEL_LOAD_FAILED", "MODEL_LOADED": "WARMUP_FAILED",
            "WARMUP_RUNNING": "WARMUP_FAILED", "WARMUP_SUCCESS": "INFERENCE_FAILED",
        }.get(phase, "INFERENCE_FAILED")
        if isinstance(exc, MemoryError):
            failure = "OUT_OF_MEMORY"
        if isinstance(exc, FileNotFoundError) or getattr(exc, "status", None) == 404:
            failure = "MODEL_NOT_FOUND"
        emit(failure, lastError=safe_error(exc), failureStage=phase)
    finally:
        connection.close()


class ModelManager:
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

    @property
    def config_override_rejected(self):
        return self.facts.get("configOverrideRejected")

    @property
    def lifecycle(self):
        from types import SimpleNamespace
        return SimpleNamespace(state=self.phase)

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
            self.error_report = {"code": "MODEL_STARTUP_FAILED" if self.ready_at is None else "INFERENCE_FAILED",
                                 "stage": phase, "reason": self.last_error, "permanent": True}
            self._ready_event.set()
        if phase == "READY":
            if self.ready_at is None:
                self.ready_at = time.time()
                self.facts["coldStartMs"] = round((time.monotonic() - self._boot_monotonic) * 1000)
                self._startup_duration_ms = self.facts["coldStartMs"]
            self._ready_event.set()
        log.info("MODEL_STATE state=%s diagnostic=%s", phase, self.last_error or "-")

    def ensure_loading(self, force=False):
        # force is accepted for compatibility but NEVER restarts a failed/ready model.
        if self._started or self.phase in FAILURES:
            return
        self._started = True
        self.started_at = time.time()
        self._boot_monotonic = time.monotonic()
        self._transition("BOOT")
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
                        except Exception:
                            # Stop decoding for a broken consumer without killing
                            # the persistent model. Keep admission locked until ack.
                            self._callback = None
                            self._pipe.send({"kind": "cancel"})
                    elif kind in {"result", "error"} and self._current and not self._current.done():
                        if kind == "result":
                            self.last_generation_metrics = event.get("metrics")
                            self._current.set_result(event["text"])
                        else:
                            self.last_generation_metrics = event.get("metrics")
                            self._current.set_exception(LLMResponseError(event["message"], status_code=502, error_type=event["code"]))
                now = time.monotonic()
                if self.ready_at is None:
                    stage_timeout = PHASES.get(self.phase, (0,))[0] or 0
                    if now - self._boot_monotonic > self.settings.local_model_startup_timeout or (stage_timeout and now - self._phase_entered > stage_timeout):
                        stage = self.phase
                        code = PHASES.get(stage, (0, "", "RUNTIME_FAILED"))[2]
                        if code not in FAILURES:
                            code = "RUNTIME_FAILED"
                        await self._fail(code, f"MODEL_STARTUP_FAILED: hard deadline exceeded in {stage}")
                        break
                elif self._current and not self._current.done() and now - self._last_activity > self.settings.local_inference_idle_timeout:
                    await self._fail("INFERENCE_FAILED", "Native inference stalled (no decoded tokens within idle deadline)")
                    break
                if not self._process.is_alive() and self.phase not in FAILURES:
                    await self._fail("OUT_OF_MEMORY" if self._process.exitcode == -9 else "RUNTIME_FAILED", f"Model worker exited unexpectedly (exit={self._process.exitcode})")
                    break
                await asyncio.sleep(0.01)
        except (EOFError, OSError) as exc:
            if self.phase not in FAILURES:
                await asyncio.to_thread(self._process.join, 0.2)
                code = "OUT_OF_MEMORY" if self._process.exitcode == -9 else "RUNTIME_FAILED"
                await self._fail(code, f"Worker connection closed (exit={self._process.exitcode}): {safe_error(exc)}")
        except Exception as exc:
            await self._fail("RUNTIME_FAILED", f"Supervisor failure: {safe_error(exc)}")
        finally:
            if self.phase in FAILURES and self._current and not self._current.done():
                self._current.set_exception(LLMResponseError(self.last_error, status_code=503, error_type=self.phase))

    def is_ready(self):
        return bool(self.phase in {"READY", "SERVING"} and self.facts.get("inferenceTest")
                    and self.facts.get("warmupComplete") and self._process and self._process.is_alive())

    async def wait_ready(self, timeout=0):
        # Observational: no download, retry, loading or implicit queueing.
        if self.is_ready():
            return
        raise LLMResponseError(self.last_error or f"Model startup has not completed ({self.phase})",
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
        text = await self.generate(system_prompt="Answer briefly.", user_prompt="What is 2 + 2?", max_tokens=16)
        return {"ok": bool(text.strip()), "answer": text, "generation": self.last_generation_metrics}

    async def preflight(self):
        return {"success": bool(self.facts.get("fileValid")), "scope": "startup-observation", "runtime": self.settings.local_model_runtime, "model": self.facts.get("effectiveModelId", self.settings.local_model_id), "fileExists": self.facts.get("fileExists", False), "fileValid": bool(self.facts.get("fileValid"))}

    def snapshot(self, include_source=False):
        snap = {**self.facts, "state": self.state, "lifecycle": self.phase, "phase": self.phase,
                "runtime": self.settings.local_model_runtime, "modelId": self.facts.get("effectiveModelId", self.settings.local_model_id),
                "ready": self.is_ready(), "inferenceAvailable": self.is_ready(),
                "lastError": self.last_error or None, "errorDetail": self.error_detail or None,
                "lastGeneration": self.last_generation_metrics, "lastSelfTest": self.last_self_test,
                "contextSize": self.settings.local_model_ctx_size, "threads": self.settings.local_model_threads,
                "loadedAt": self.ready_at, "startupDurationMs": self._startup_duration_ms if self._startup_duration_ms is not None else (round((time.monotonic() - self._boot_monotonic) * 1000) if self._started else None),
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
