#!/usr/bin/env python3
"""Evaluate a checkpoint on the golden suite + validation split."""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "ai_engine"))
sys.path.insert(0, str(ROOT / "evaluation"))

from golden import GOLDEN_CASES  # noqa: E402
from hrm.config import TASK_TYPES, TOOL_NAMES  # noqa: E402
from hrm.hrm import EduNovaHRM  # noqa: E402
from hrm.outputs import parse_structured_output  # noqa: E402
from hrm.tokenizer import EduNovaTokenizer  # noqa: E402


def run(checkpoint: str) -> dict:
    import torch

    ckpt = Path(checkpoint)
    model = EduNovaHRM.from_pretrained(ckpt)
    tokenizer = EduNovaTokenizer.load(ckpt)
    model.eval()
    started = time.monotonic()
    rss_before = _rss()
    results = []
    tool_ok = 0
    json_ok = 0
    for case in GOLDEN_CASES:
        ids = tokenizer.encode(case["prompt"], add_special=True)
        padded, mask = tokenizer.pad([ids], model.config.max_seq_len)
        plan = model.plan(torch.tensor(padded), torch.tensor(mask))
        expected_task = case.get("task_type")
        expected_tools = set(case.get("tools") or [])
        predicted = set(plan.get("tools") or [])
        if not expected_tools:
            hit = plan.get("need_tools") is False or plan.get("primary_tool") in {"none", None}
        else:
            hit = bool(predicted & expected_tools) or plan.get("primary_tool") in expected_tools
        tool_ok += int(hit)
        # Structured generation
        out_ids = model.generate(torch.tensor(padded), max_new_tokens=64, temperature=0.0)
        text = tokenizer.decode(out_ids[0].tolist())
        try:
            structured = parse_structured_output(text)
            valid = True
        except Exception:
            structured = None
            valid = False
        json_ok += int(valid)
        results.append(
            {
                "id": case["id"],
                "prompt": case["prompt"],
                "expected_task": expected_task,
                "predicted_task": plan.get("task_type"),
                "task_match": plan.get("task_type") == expected_task,
                "expected_tools": sorted(expected_tools),
                "predicted_tools": sorted(predicted),
                "tool_hit": hit,
                "json_valid": valid,
                "output_type": None if structured is None else structured.type,
            }
        )
    elapsed = time.monotonic() - started
    n = max(1, len(GOLDEN_CASES))
    report = {
        "checkpoint": str(ckpt),
        "parameter_count": model.parameter_count(),
        "cases": len(GOLDEN_CASES),
        "tool_selection_accuracy": tool_ok / n,
        "task_accuracy": sum(1 for r in results if r["task_match"]) / n,
        "json_validity": json_ok / n,
        "latency_ms_total": int(elapsed * 1000),
        "latency_ms_per_case": int(elapsed * 1000 / n),
        "rss_mb": _rss(),
        "rss_delta_mb": round(_rss() - rss_before, 1),
        "results": results,
    }
    out = ROOT / "evaluation" / "last_report.json"
    out.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps({k: v for k, v in report.items() if k != "results"}, indent=2))
    return report


def _rss() -> float:
    try:
        with open("/proc/self/status", encoding="utf-8") as handle:
            for line in handle:
                if line.startswith("VmRSS:"):
                    return round(int(line.split()[1]) / 1024, 1)
    except OSError:
        return 0.0
    return 0.0


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--checkpoint", required=True)
    args = parser.parse_args()
    run(args.checkpoint)


if __name__ == "__main__":
    main()
