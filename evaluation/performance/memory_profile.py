#!/usr/bin/env python3
"""Measure real resident memory of the HRM inference path (CPU).

Reports RSS of THIS process at: interpreter baseline, after `import torch`,
after checkpoint load, after a 16-token generate, plus checkpoint disk size.
Run with the same interpreter that would serve the model:

    python evaluation/performance/memory_profile.py \
        --checkpoint post_training/checkpoints/edunova-hrm-20m-sft --out docs/results/hrm-memory.json
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def _rss_mib() -> float:
    try:
        with open("/proc/self/status", encoding="utf-8") as handle:
            for line in handle:
                if line.startswith("VmRSS:"):
                    return round(int(line.split()[1]) / 1024, 1)
    except OSError:
        pass
    import resource

    return round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024, 1)


def main() -> dict:
    parser = argparse.ArgumentParser()
    parser.add_argument("--checkpoint", required=True)
    parser.add_argument("--max-new", type=int, default=16)
    parser.add_argument("--out", default=None)
    args = parser.parse_args()

    report: dict = {
        "date": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "python": sys.version.split()[0],
        "checkpoint": args.checkpoint,
        "measurements": {},
    }
    m = report["measurements"]
    m["baseline_rss_mib"] = _rss_mib()

    import torch

    report["torch_version"] = torch.__version__
    m["after_import_torch_rss_mib"] = _rss_mib()

    sys.path.insert(0, str(ROOT / "ai_engine"))
    from hrm.hrm import EduNovaHRM
    from hrm.tokenizer import EduNovaTokenizer

    ckpt = Path(args.checkpoint)
    tokenizer = EduNovaTokenizer.load(ckpt)
    model = EduNovaHRM.from_pretrained(ckpt)
    weights = ckpt / "pytorch_model.pt"
    report["parameters"] = model.parameter_count()
    report["tokenizer_version"] = tokenizer.version
    m["checkpoint_disk_mib"] = round(weights.stat().st_size / (1024 * 1024), 2)
    m["after_model_load_rss_mib"] = _rss_mib()

    ids = tokenizer.prompt_ids("You are EduNova HRM.", "What is my attendance?")
    input_ids = torch.tensor([ids[: model.config.max_seq_len]], dtype=torch.long)
    started = time.monotonic()
    out = model.generate(
        input_ids,
        max_new_tokens=args.max_new,
        temperature=0.0,
        eos_id=tokenizer.eos_id,
        start_token_id=tokenizer.token_to_id["<assistant>"],
    )
    duration = time.monotonic() - started
    m["after_generate_rss_mib"] = _rss_mib()
    m["generated_tokens"] = int(out.size(1))
    m["generate_wall_time_sec"] = round(duration, 3)
    m["sample_output"] = tokenizer.decode(out[0].tolist(), skip_special=True)[:200]
    # Weights-only floor: fp32 parameters, independent of framework overhead.
    m["weights_only_mib"] = round(model.parameter_count() * 4 / (1024 * 1024), 2)
    report["render_free_512_fits"] = bool(m["after_generate_rss_mib"] < 512)

    print(json.dumps(report, indent=2))
    if args.out:
        out_path = Path(args.out)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
        print("wrote", out_path)
    return report


if __name__ == "__main__":
    main()
