#!/usr/bin/env python3
"""Offline shadow evaluation: run the HRM alongside the production llama.cpp
path on the same prompts and record agreement. OFFLINE ONLY — production
never dual-loads both runtimes (Render Free is 512 MiB; see docs).

    python evaluation/shadow.py --hrm-checkpoint post_training/checkpoints/edunova-hrm-20m-sft \
        --cases evaluation/tools/benchmark.jsonl [--llama-model /path/to/model.gguf]

If llama-cpp-python or a GGUF model is unavailable, the llama side is
reported as NOT IMPLEMENTED with the reason, and the HRM side still runs.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "ai_engine"))
sys.path.insert(0, str(ROOT / "evaluation"))
sys.path.insert(0, str(ROOT / "evaluation" / "structured_output"))

from eval_structured import Evaluator, schema_check  # noqa: E402


def _llama_side(prompts: list[str], model_path: str | None, max_new: int) -> dict:
    if not model_path:
        return {"status": "NOT IMPLEMENTED", "reason": "no --llama-model GGUF path given", "outputs": {}}
    try:
        from llama_cpp import Llama  # type: ignore
    except Exception as exc:  # pragma: no cover - depends on local env
        return {"status": "NOT IMPLEMENTED", "reason": f"llama-cpp-python not installed: {exc}", "outputs": {}}
    path = Path(model_path)
    if not path.exists():
        return {"status": "NOT IMPLEMENTED", "reason": f"GGUF not found: {model_path}", "outputs": {}}
    llm = Llama(model_path=str(path), n_ctx=512, n_threads=2, verbose=False)
    outputs = {}
    for prompt in prompts:
        text = f"<system>You are EduNova.</system><user>{prompt}</user><assistant>"
        res = llm(text, max_tokens=max_new, temperature=0.0)
        outputs[prompt] = res["choices"][0]["text"].strip()
    return {"status": "ran", "model": str(path), "outputs": outputs}


def main() -> dict:
    parser = argparse.ArgumentParser()
    parser.add_argument("--hrm-checkpoint", required=True)
    parser.add_argument("--cases", default=str(ROOT / "evaluation" / "tools" / "benchmark.jsonl"))
    parser.add_argument("--llama-model", default=None)
    parser.add_argument("--limit", type=int, default=24)
    parser.add_argument("--max-new", type=int, default=128)
    parser.add_argument("--out", default=None)
    args = parser.parse_args()

    rows = [json.loads(l) for l in Path(args.cases).read_text(encoding="utf-8").splitlines() if l.strip()]
    rows = rows[: args.limit]
    prompts = [r["prompt"] for r in rows]

    ev = Evaluator(Path(args.hrm_checkpoint), max_new=args.max_new)
    hrm_outputs: dict[str, dict] = {}
    started = time.monotonic()
    for row in rows:
        text, _ = ev.generate(row["prompt"], "constrained")
        ok, kind, tool = schema_check(text)
        hrm_outputs[row["prompt"]] = {"text": text[:300], "schema_ok": ok, "type": kind, "tool": tool}
    hrm_time = round(time.monotonic() - started, 1)

    llama = _llama_side(prompts, args.llama_model, args.max_new)
    agreement = None
    if llama["status"] == "ran":
        agree = sum(
            1
            for row in rows
            if row["tool"] in (llama["outputs"].get(row["prompt"]) or "")
            and row["tool"] == (hrm_outputs[row["prompt"]]["tool"] or "")
        )
        agreement = {"both_named_expected_tool": agree, "of": len(rows)}

    report = {
        "date": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "offline_only": True,
        "note": "Shadow comparison only. Production serves llama.cpp alone; HRM is not promoted.",
        "cases": len(rows),
        "hrm": {
            "checkpoint": args.hrm_checkpoint,
            "wall_time_sec": hrm_time,
            "schema_ok_rate": round(sum(1 for o in hrm_outputs.values() if o["schema_ok"]) / len(rows), 4),
            "tool_hit_rate": round(
                sum(1 for row in rows if hrm_outputs[row["prompt"]]["tool"] == row["tool"]) / len(rows), 4
            ),
            "outputs": hrm_outputs,
        },
        "llama_cpp": llama,
        "agreement": agreement,
    }
    print(json.dumps({k: v for k, v in report.items() if k not in {"hrm", "llama_cpp"}}, indent=2))
    print("hrm_schema_ok", report["hrm"]["schema_ok_rate"], "hrm_tool_hit", report["hrm"]["tool_hit_rate"])
    print("llama side:", llama["status"], llama.get("reason", ""))
    if args.out:
        out_path = Path(args.out)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
        print("wrote", out_path)
    return report


if __name__ == "__main__":
    main()
