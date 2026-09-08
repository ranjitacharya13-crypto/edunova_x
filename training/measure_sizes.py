#!/usr/bin/env python3
"""Measure actual parameter counts, disk size, and one-step train/infer speed."""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "ai_engine"))

from hrm.config import SIZE_PRESETS  # noqa: E402
from hrm.hrm import EduNovaHRM  # noqa: E402


def measure(size: str) -> dict:
    import torch

    cfg = SIZE_PRESETS[size]
    model = EduNovaHRM(cfg)
    params = model.parameter_count()
    bytes_fp32 = params * 4
    ids = torch.randint(0, min(64, cfg.vocab_size), (1, 16))
    t0 = time.monotonic()
    out = model(ids)
    torch.mean(out["logits"]).backward()
    train_ms = (time.monotonic() - t0) * 1000
    model.zero_grad(set_to_none=True)
    model.eval()
    t1 = time.monotonic()
    with torch.no_grad():
        _ = model.generate(ids, max_new_tokens=8, temperature=0.0)
    infer_ms = (time.monotonic() - t1) * 1000
    rss = 0.0
    try:
        with open("/proc/self/status", encoding="utf-8") as handle:
            for line in handle:
                if line.startswith("VmRSS:"):
                    rss = int(line.split()[1]) / 1024
    except OSError:
        pass
    del model
    return {
        "size": size,
        "name": cfg.name,
        "estimated_params": cfg.estimate_parameters(),
        "measured_params": params,
        "disk_fp32_mb": round(bytes_fp32 / (1024 * 1024), 2),
        "one_step_train_ms": round(train_ms, 1),
        "generate_8_tokens_ms": round(infer_ms, 1),
        "rss_mb": round(rss, 1),
    }


def main() -> None:
    sizes = sys.argv[1:] or ["20m"]
    rows = [measure(s) for s in sizes]
    print(json.dumps(rows, indent=2))
    (ROOT / "docs" / "results" / "hrm-size-measure.json").write_text(json.dumps(rows, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
