"""ResourceManager + model compatibility check for the AI inference service.

The model is NEVER loaded unless the container is proven to have enough memory:

    required_mb = model_weights + kv_cache + runtime_overhead + server_overhead + safety_margin

Everything here is pure Python (no torch / llama_cpp import) so the check can
run in the parent process BEFORE a worker is spawned, and so the lightweight
orchestrator can reuse the same detection for /system/resources.
"""
from __future__ import annotations

import os
from pathlib import Path
import platform
import shutil
import struct
from typing import Any

MIB = 1024 * 1024

# Overheads measured on Render/Docker CPU containers (python 3.11, uvicorn),
# re-baselined for the Render FREE tier (512 MiB hard cgroup limit):
#
#   * an idle `uvicorn inference_server:app` parent (FastAPI + supervisor,
#     no model, no torch) sits at ~55–70 MiB RSS;
#   * the supervised llama.cpp worker starts at ~45–55 MiB before weights are
#     touched; its llama.cpp compute buffers scale with model size (the
#     weights-scaled term below), and its KV cache is estimated per-token from
#     the actual GGUF header at the real n_ctx;
#   * the old flat 160 MiB "runtime" + 140 MiB "server" + 128 MiB "margin"
#     budget claimed ~28% of a free instance for overhead alone and falsely
#     reported MODEL_RESOURCE_INSUFFICIENT for configurations that fit.
LLAMA_RUNTIME_OVERHEAD_MB = 140      # llama.cpp compute buffers + ggml scratch (base)
TORCH_RUNTIME_OVERHEAD_MB = 900      # torch + transformers import + allocator
SERVER_OVERHEAD_MB = 110             # FastAPI parent + supervised worker interpreter
EMBEDDING_OVERHEAD_MB = 260          # sentence-transformers MiniLM in the same service
SAFETY_MARGIN_MB = 64                # never run at the OOM edge
# required_mb already carries a 64 MiB safety margin; the recommendation adds
# another ~10% (KV growth, burst allocations, page-cache pressure) and rounds
# UP to a real Render plan size. The free profile (SmolLM2-135M @ 2048, RAG
# off) needs ~450 MiB -> recommended 512 MiB -> the FREE plan itself: sizing
# guidance that matches reality instead of steering to a paid instance.
RECOMMENDED_HEADROOM_RATIO = 1.10    # recommended_mb = required * 1.10, rounded to plan sizes

# Compute buffers grow with model size (attention/FFN scratch is proportional
# to hidden dims and layer count). Every 6 MiB of weights past 160 MiB adds
# ~1 MiB of scratch estimate — 1.5B-class models land near the old flat value.
_LLAMA_BUFFERS_WEIGHT_DIVISOR = 6
_LLAMA_BUFFERS_WEIGHT_FLOOR_MB = 160

_PLAN_SIZES_MB = (512, 1024, 2048, 4096, 8192, 16384)

# GGUF file_type -> quantization name (ggml_ftype).
_GGUF_FILE_TYPES = {
    0: "F32", 1: "F16", 2: "Q4_0", 3: "Q4_1", 7: "Q8_0", 8: "Q5_0", 9: "Q5_1",
    10: "Q2_K", 11: "Q3_K_S", 12: "Q3_K_M", 13: "Q3_K_L", 14: "Q4_K_S", 15: "Q4_K_M",
    16: "Q5_K_S", 17: "Q5_K_M", 18: "Q6_K", 19: "IQ2_XXS", 20: "IQ2_XS", 21: "Q2_K_S",
    22: "IQ3_XS", 23: "IQ3_XXS", 24: "IQ1_S", 25: "IQ4_NL", 26: "IQ3_S", 27: "IQ3_M",
    28: "IQ2_S", 29: "IQ2_M", 30: "IQ4_XS", 31: "IQ1_M", 32: "BF16",
}


def _read_int(path: str) -> int | None:
    try:
        raw = Path(path).read_text().strip()
        if raw == "max":
            return None
        value = int(raw)
        return value if value < 2**60 else None
    except (OSError, ValueError):
        return None


def _meminfo() -> dict[str, int]:
    result: dict[str, int] = {}
    try:
        for line in Path("/proc/meminfo").read_text().splitlines():
            key, _, rest = line.partition(":")
            parts = rest.split()
            if parts:
                result[key.strip()] = int(parts[0]) * 1024
    except (OSError, ValueError):
        pass
    return result


def _cgroup_memory_usage() -> int | None:
    return _read_int("/sys/fs/cgroup/memory.current") or _read_int("/sys/fs/cgroup/memory/memory.usage_in_bytes")


def cgroup_memory_limit() -> int | None:
    override = os.getenv("AI_MEMORY_LIMIT_MB", "").strip()
    if override:
        try:
            return int(override) * MIB
        except ValueError:
            pass
    return _read_int("/sys/fs/cgroup/memory.max") or _read_int("/sys/fs/cgroup/memory/memory.limit_in_bytes")


def _gpu_info() -> dict[str, Any]:
    # Detection without importing torch: NVIDIA exposes /proc/driver/nvidia.
    nvidia = Path("/proc/driver/nvidia/gpus")
    if nvidia.exists():
        try:
            return {"available": True, "vendor": "nvidia", "count": len(list(nvidia.iterdir()))}
        except OSError:
            return {"available": True, "vendor": "nvidia", "count": None}
    return {"available": False, "vendor": None, "count": 0}


class ResourceManager:
    """Detect CPU / RAM / GPU / disk before any model is loaded."""

    def __init__(self, model_dir: str | None = None):
        self.model_dir = model_dir

    def snapshot(self) -> dict[str, Any]:
        meminfo = _meminfo()
        host_total = meminfo.get("MemTotal")
        host_available = meminfo.get("MemAvailable")
        limit = cgroup_memory_limit()
        usage = _cgroup_memory_usage()
        if limit and host_total:
            total = min(limit, host_total)
        else:
            total = limit or host_total
        if limit and usage is not None:
            available = max(0, limit - usage)
            if host_available is not None:
                available = min(available, host_available)
        else:
            available = host_available
        try:
            cpu_visible = len(os.sched_getaffinity(0))
        except AttributeError:
            cpu_visible = os.cpu_count() or 1
        cpu_quota = None
        try:
            quota, period = Path("/sys/fs/cgroup/cpu.max").read_text().split()[:2]
            if quota != "max":
                cpu_quota = round(int(quota) / int(period), 2)
        except (OSError, ValueError, ZeroDivisionError):
            pass
        disk_free_mb = disk_total_mb = None
        try:
            target = self.model_dir if self.model_dir and Path(self.model_dir).exists() else "/"
            usage_stat = shutil.disk_usage(target)
            disk_free_mb, disk_total_mb = usage_stat.free // MIB, usage_stat.total // MIB
        except OSError:
            pass
        return {
            "ram_total_mb": (total // MIB) if total else None,
            "ram_available_mb": (available // MIB) if available is not None else None,
            "ram_limit_mb": (limit // MIB) if limit else None,
            "ram_used_mb": (usage // MIB) if usage is not None else None,
            "cpu_cores": cpu_visible,
            "cpu_quota_cores": cpu_quota,
            "architecture": platform.machine(),
            "os": platform.system(),
            "python": platform.python_version(),
            "gpu": _gpu_info()["available"],
            "gpu_info": _gpu_info(),
            "disk_free_mb": disk_free_mb,
            "disk_total_mb": disk_total_mb,
        }


# --------------------------------------------------------------------------- GGUF
def _gguf_read_string(handle) -> str:
    (length,) = struct.unpack("<Q", handle.read(8))
    return handle.read(length).decode("utf-8", errors="replace")


_GGUF_SCALARS = {0: ("<B", 1), 1: ("<b", 1), 2: ("<H", 2), 3: ("<h", 2), 4: ("<I", 4), 5: ("<i", 4),
                 6: ("<f", 4), 7: ("<?", 1), 10: ("<Q", 8), 11: ("<q", 8), 12: ("<d", 8)}


def _gguf_read_value(handle, value_type: int):
    if value_type in _GGUF_SCALARS:
        fmt, size = _GGUF_SCALARS[value_type]
        return struct.unpack(fmt, handle.read(size))[0]
    if value_type == 8:
        return _gguf_read_string(handle)
    if value_type == 9:
        (item_type,) = struct.unpack("<I", handle.read(4))
        (count,) = struct.unpack("<Q", handle.read(8))
        # Arrays (vocabularies) can be huge; read but only keep the length.
        for _ in range(count):
            _gguf_read_value(handle, item_type)
        return {"array_length": count}
    raise ValueError(f"Unknown GGUF value type {value_type}")


def inspect_gguf(path: str | Path, max_keys: int = 4000) -> dict[str, Any]:
    """Read GGUF header metadata (architecture, layers, kv heads, quantization)."""
    path = Path(path)
    info: dict[str, Any] = {"file_bytes": path.stat().st_size}
    with path.open("rb") as handle:
        if handle.read(4) != b"GGUF":
            raise ValueError("Not a GGUF file")
        (version,) = struct.unpack("<I", handle.read(4))
        (tensor_count,) = struct.unpack("<Q", handle.read(8))
        (kv_count,) = struct.unpack("<Q", handle.read(8))
        info.update({"gguf_version": version, "tensor_count": tensor_count})
        wanted_suffixes = ("block_count", "embedding_length", "attention.head_count",
                           "attention.head_count_kv", "context_length", "attention.key_length", "attention.value_length")
        for _ in range(min(kv_count, max_keys)):
            key = _gguf_read_string(handle)
            (value_type,) = struct.unpack("<I", handle.read(4))
            value = _gguf_read_value(handle, value_type)
            if key == "general.architecture":
                info["architecture"] = value
            elif key == "general.file_type":
                info["file_type"] = value
                info["quantization"] = _GGUF_FILE_TYPES.get(int(value), f"ftype_{value}")
            elif key == "general.name":
                info["name"] = value
            elif key == "general.size_label":
                info["size_label"] = value
            elif key.endswith(wanted_suffixes) and not key.startswith("tokenizer"):
                info[key.split(".", 1)[1]] = value
    return info


def estimate_kv_cache_mb(meta: dict[str, Any], ctx: int) -> int:
    layers = int(meta.get("block_count") or 0)
    heads = int(meta.get("attention.head_count") or 0)
    kv_heads = int(meta.get("attention.head_count_kv") or heads or 0)
    embd = int(meta.get("embedding_length") or 0)
    if not (layers and heads and embd):
        # Unknown architecture: assume a 0.5B-class dense model (24 layers, 2 KV heads x 64).
        return int(ctx * 2 * 24 * 128 * 2 / MIB) + 8
    head_dim = int(meta.get("attention.key_length") or (embd // heads))
    bytes_per_token = 2 * layers * kv_heads * head_dim * 2  # K and V, f16
    return int(ctx * bytes_per_token / MIB) + 8


def estimate_requirement(*, runtime: str, model_path: str | Path | None, ctx: int,
                         catalogue_ram_mb: int = 0, expected_bytes: int = 0, with_embeddings: bool = True) -> dict[str, Any]:
    """Break down the memory a model needs in this process, in MiB.

    Deliberately honest, not pessimistic: with a 512 MiB Render Free cgroup,
    overhead numbers that are too high reject configurations that genuinely
    fit (the false MODEL_RESOURCE_INSUFFICIENT incident), and numbers that are
    too low ship an OOM-kill loop. Each term is a measured ceiling:

      weights    actual GGUF size when cached (else pinned catalogue bytes);
      KV cache   from the GGUF header (layers/kv-heads/head-dim) at REAL ctx;
      runtime    llama.cpp compute buffers/scratch: flat base + a term that
                 scales with model size (small models need little);
      server     parent uvicorn + supervised worker interpreter;
      embeddings ONLY when RAG_ENABLED (a disabled runtime never imports
                 torch — charging it would misreport the process budget);
      margin     fixed headroom so generation never runs at the OOM edge.
    """
    meta: dict[str, Any] = {}
    weights_mb = 0
    if model_path and Path(str(model_path)).is_file():
        try:
            meta = inspect_gguf(model_path)
            weights_mb = int(meta["file_bytes"] / MIB) + 1
        except (OSError, ValueError, struct.error):
            weights_mb = int(Path(str(model_path)).stat().st_size / MIB) + 1
    elif expected_bytes:
        weights_mb = int(expected_bytes / MIB) + 1
    if runtime == "torch":
        runtime_overhead = TORCH_RUNTIME_OVERHEAD_MB
        kv_mb = estimate_kv_cache_mb(meta, ctx)
        if not weights_mb:
            weights_mb = max(0, catalogue_ram_mb - runtime_overhead)
    else:
        kv_mb = estimate_kv_cache_mb(meta, ctx)
        runtime_overhead = LLAMA_RUNTIME_OVERHEAD_MB + max(
            0, (weights_mb - _LLAMA_BUFFERS_WEIGHT_FLOOR_MB) // _LLAMA_BUFFERS_WEIGHT_DIVISOR)
        if not weights_mb and catalogue_ram_mb:
            # Catalogue ram_mb already includes KV + compute at the recorded context.
            weights_mb = max(0, catalogue_ram_mb - kv_mb - runtime_overhead)
    embedding_mb = EMBEDDING_OVERHEAD_MB if with_embeddings else 0
    required = weights_mb + kv_mb + runtime_overhead + SERVER_OVERHEAD_MB + embedding_mb + SAFETY_MARGIN_MB
    recommended = int(required * RECOMMENDED_HEADROOM_RATIO)
    recommended = next((size for size in _PLAN_SIZES_MB if size >= recommended), recommended)
    return {
        "model_weights_mb": weights_mb,
        "kv_cache_mb": kv_mb,
        "runtime_overhead_mb": runtime_overhead,
        "server_overhead_mb": SERVER_OVERHEAD_MB,
        "embedding_overhead_mb": embedding_mb,
        "safety_margin_mb": SAFETY_MARGIN_MB,
        "required_mb": required,
        "recommended_mb": recommended,
        "context_length": ctx,
        "quantization": meta.get("quantization"),
        "architecture": meta.get("architecture"),
        "layers": meta.get("block_count"),
        "size_label": meta.get("size_label"),
        "source": "gguf-header" if meta else ("catalogue" if catalogue_ram_mb or expected_bytes else "default"),
    }


class ResourceInsufficient(RuntimeError):
    code = "MODEL_RESOURCE_INSUFFICIENT"

    def __init__(self, requirement: dict[str, Any], resources: dict[str, Any]):
        self.requirement = requirement
        self.resources = resources
        self.required_mb = int(requirement["required_mb"])
        self.available_mb = int(resources.get("ram_limit_mb") or resources.get("ram_total_mb") or 0)
        self.recommended_mb = int(requirement["recommended_mb"])
        super().__init__(
            f"MODEL_RESOURCE_INSUFFICIENT: model needs {self.required_mb} MiB "
            f"(weights {requirement['model_weights_mb']} + KV {requirement['kv_cache_mb']} + runtime "
            f"{requirement['runtime_overhead_mb']} + server {requirement['server_overhead_mb']} + embeddings "
            f"{requirement['embedding_overhead_mb']} + margin {requirement['safety_margin_mb']}); "
            f"this container has {self.available_mb} MiB. Deploy the inference service on a >= "
            f"{self.recommended_mb} MiB instance or select a smaller quantized model."
        )

    def report(self) -> dict[str, Any]:
        return {"error": self.code, "required_mb": self.required_mb, "available_mb": self.available_mb,
                "recommended_mb": self.recommended_mb, "breakdown": self.requirement, "resources": self.resources}


def check_model_fits(requirement: dict[str, Any], resources: dict[str, Any] | None = None) -> dict[str, Any]:
    """Raise ResourceInsufficient when the container cannot hold the model."""
    resources = resources or ResourceManager().snapshot()
    capacity = resources.get("ram_limit_mb") or resources.get("ram_total_mb")
    if capacity is not None and int(capacity) < int(requirement["required_mb"]):
        raise ResourceInsufficient(requirement, resources)
    return {"fits": True, "capacity_mb": capacity, **requirement}
