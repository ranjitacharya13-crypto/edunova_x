"""Adaptive compute detection for the EduNova AI inference service.

Every decision here is a *suggestion* computed from real environment facts
(cgroup memory limit, visible CPU count, torch device, model parameter count)
and can always be overridden with explicit environment variables.  The rules:

- LOW-END / NORMAL DEVICE  ->  lightweight client, remote inference (the
  device never downloads or loads the model — see the API/frontend layers).
- SERVER (this process)    ->  remote inference for every client; pick the
  safest dtype/threads/context that still fits the container and yields the
  best throughput for the selected model.

Do NOT confuse model size with intelligence.  The model choice is made from a
catalogue (``config.KNOWN_TORCH_MODELS``) and is deliberately kept small so it
fits the infrastructure; capability is added through tools + retrieval +
memory + EduNova data + web research, not by inflating the prompt.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Any

logger = logging.getLogger("edunova.inference.adaptive")


def memory_limit_bytes() -> int | None:
    """cgroup v2 memory.max; None when unconstrained."""
    for path in ("/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory/memory.limit_in_bytes"):
        try:
            raw = Path(path).read_text().strip()
            if path.endswith("memory.limit_in_bytes"):
                value = int(raw)
                return None if value >= (1 << 60) else value
            return None if raw == "max" else int(raw)
        except (OSError, ValueError):
            continue
    return None


def cpu_quota_cores() -> float | None:
    """cgroup v2 cpu.max → (quota/period) CPU cores; None when unconstrained."""
    try:
        raw = Path("/sys/fs/cgroup/cpu.max").read_text().split()
        if raw[0] == "max":
            return None
        return max(0.1, round(int(raw[0]) / max(1, int(raw[1])), 2))
    except (OSError, ValueError, IndexError):
        return None


def visible_cpu_count() -> int:
    try:
        return max(1, int(os.cpu_count() or 1))
    except (TypeError, ValueError):
        return 1


def has_avx512_bf16() -> bool:
    """Best-effort CPU flag probe (no external deps)."""
    try:
        with open("/proc/cpuinfo", encoding="utf-8", errors="ignore") as handle:
            flags = " ".join(
                line.split(":", 1)[1].strip()
                for line in handle
                if line.startswith("flags")
            )
        return "avx512_bf16" in flags or "amx_bf16" in flags
    except OSError:
        return False


def environment_report() -> dict[str, Any]:
    """Safe facts about the compute environment (no secrets)."""
    limit = memory_limit_bytes()
    quota = cpu_quota_cores()
    return {
        "memoryLimitBytes": limit,
        "memoryLimitMb": int(limit / (1024 * 1024)) if limit else None,
        "cpuQuotaCores": quota,
        "visibleCpuCount": visible_cpu_count(),
        "avx512Bf16": has_avx512_bf16(),
        "device": "cuda",
        "cudaAvailable": _cuda_available(),
    }


def _cuda_available() -> bool:
    try:
        import torch  # noqa: PLC0415 — probe only

        return bool(torch.cuda.is_available())
    except Exception:
        return False


def pick_dtype(
    *,
    parameter_count: int,
    memory_limit_bytes_value: int | None,
    requested: str = "auto",
    base_overhead_bytes: int = 900 * 1024 * 1024,
    safe_fraction: float = 0.9,
) -> str:
    """Choose a torch dtype that fits the container and runs best on CPU.

    Preference order on CPU: int8 (dynamic quantization) -> bf16 -> fp32.
    ``requested`` may be ``auto`` or one of fp32/bf16/int8.  Returns the chosen
    dtype or ``"error"`` plus a reason dict when nothing fits.
    """
    import torch  # noqa: PLC0415 — needs torch to know what is supported

    if parameter_count <= 0:
        return requested if requested != "auto" else ("bf16" if torch.cuda.is_available() else "int8")

    dtype = str(requested or "auto").strip().lower().replace("float32", "fp32").replace(
        "float16", "fp16"
    ).replace("bfloat16", "bf16").replace("qint8", "int8").replace("int8", "int8")
    if dtype in {"fp32", "bf16", "int8", "fp16"}:
        return dtype if dtype != "fp16" else ("bf16" if torch.cuda.is_available() else "fp32")
    if dtype != "auto":
        logger.warning("UNKNOWN_DTYPE_REQUESTED dtype=%s falling back to auto", requested)

    candidates: list[tuple[str, int]] = []
    for name, bytes_per_param in (("int8", 1), ("bf16", 2), ("fp32", 4)):
        try:
            dtype_obj = getattr(torch, name.replace("int8", "qint8").replace("bf16", "bfloat16").replace("fp32", "float32"))
            # qint8 always constructible; bf16/fp32 always constructible.
            _ = dtype_obj
        except Exception:
            continue
        candidates.append((name, bytes_per_param))

    if memory_limit_bytes_value and memory_limit_bytes_value > 0:
        usable = memory_limit_bytes_value * safe_fraction
        for name, bytes_per_param in candidates:
            estimate = int(parameter_count * bytes_per_param) + base_overhead_bytes
            if estimate <= usable:
                return name
        return "fp32"  # fall back to best-effort; caller may still fail

    # No known container limit: prefer int8 for small shared CPUs (speed + RAM).
    return "int8"


def pick_threads(requested: int) -> int:
    """Adaptive CPU thread count for torch intra-op parallelism.

    ``requested <= 0`` means auto: physical cores available to this container,
    capped at 4 (small models do not scale past ~4 threads on shared CPU).
    """
    if requested and requested > 0:
        return requested
    quota = cpu_quota_cores()
    if quota is not None:
        return max(1, min(4, int(quota) or 1))
    return max(1, min(4, visible_cpu_count()))


def model_cache_path(model_dir: str, repo_id_or_path: str) -> Path:
    """Filesystem location where a repo's weights should live/be found.

    - If ``repo_id_or_path`` points at an existing directory that contains a
      ``config.json`` it is used directly (offline / test models).
    - Otherwise the HuggingFace ``snapshot_download`` cache under ``model_dir``
      is used, keyed by the (sanitized) repo id.
    """
    import re  # noqa: PLC0415

    local = Path(repo_id_or_path)
    if (local / "config.json").exists():
        return local
    base = Path(model_dir)
    if (base / "config.json").exists():
        return base
    safe = re.sub(r"[^A-Za-z0-9._-]+", "--", str(repo_id_or_path).strip("/")).strip("-") or "model"
    return base / safe
