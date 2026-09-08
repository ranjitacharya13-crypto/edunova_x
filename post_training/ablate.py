#!/usr/bin/env python3
"""Tiny-model loss-component ablations (diagnostic, not a 20M score).

Trains a ~0.5M HRM for a few dozen steps under each loss mix and reports
validation tool-head accuracy. This measures whether the objective moves
the routing head, not whether the 20M model is promotion-ready.

    python post_training/ablate.py --max-steps 40 --out docs/results/hrm-phase4-ablate.json
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "ai_engine"))
sys.path.insert(0, str(ROOT / "training"))
sys.path.insert(0, str(ROOT / "post_training"))

from hrm.config import HRMConfig  # noqa: E402
from hrm.hrm import EduNovaHRM  # noqa: E402
from hrm.tokenizer import EduNovaTokenizer  # noqa: E402
from preprocessing.prepare import encode_example_aligned, load_jsonl  # noqa: E402
from loss import (  # noqa: E402
    build_label_weights,
    combine_multitask,
    structure_token_ids,
    weighted_lm_loss_with_args,
)
from train_sft import CurriculumSampler, _collate, evaluate  # noqa: E402

DATA = ROOT / "post_training" / "datasets" / "sft"

MODES = {
    "D_lm_only": {"lambda_tool": 0.0, "lambda_output": 0.0, "lambda_task": 0.0, "lambda_need": 0.0, "arg_weight": 1.0},
    "E_lm_tool": {"lambda_tool": 2.0, "lambda_output": 0.0, "lambda_task": 0.0, "lambda_need": 0.0, "arg_weight": 1.0},
    "F_lm_tool_struct": {"lambda_tool": 2.0, "lambda_output": 0.75, "lambda_task": 0.0, "lambda_need": 0.0, "arg_weight": 1.0},
    "G_full": {"lambda_tool": 2.0, "lambda_output": 0.75, "lambda_task": 0.5, "lambda_need": 0.25, "arg_weight": 3.0},
}


def _run(mode: str, lambdas: dict, tokenizer, train, val, steps: int, seed: int) -> dict:
    import torch
    import torch.nn.functional as F

    torch.manual_seed(seed)
    cfg = HRMConfig(
        name="edunova-hrm-ablate-tiny",
        vocab_size=tokenizer.vocab_size,
        d_model=64,
        n_heads=4,
        high_level_layers=1,
        low_level_layers=2,
        max_seq_len=128,
        dropout=0.0,
    )
    model = EduNovaHRM(cfg)
    opt = torch.optim.AdamW(model.parameters(), lr=3e-4)
    weights = build_label_weights(tokenizer, 2.5, 4.0, vocab_size=cfg.vocab_size)
    struct_ids = structure_token_ids(tokenizer)
    sampler = CurriculumSampler(train, 4, seed)
    sampler.active_max = 9
    arg_weight = lambdas.pop("arg_weight")
    started = time.monotonic()
    model.train()
    for step in range(steps):
        idx = sampler.sample()
        enc, enc_mask, dec, labels, arg_mask, aux = _collate([train[i] for i in idx], tokenizer.pad_id)
        out = model(enc, enc_mask, dec, tool_ids=aux["tool_id"])
        logits = out["logits"][:, :-1].contiguous()
        shifted = labels[:, 1:].contiguous()
        lm = weighted_lm_loss_with_args(logits, shifted, weights, arg_mask[:, 1:], arg_weight)
        tool = F.cross_entropy(out["tool_logits"], aux["tool_id"])
        task = F.cross_entropy(out["task_logits"], aux["task_id"])
        out_t = F.cross_entropy(out["output_type_logits"], aux["output_type_id"])
        need = F.cross_entropy(out["need_tools_logits"], aux["need_tools"])
        loss = combine_multitask(lm, tool, out_t, task, need, **lambdas)
        opt.zero_grad(set_to_none=True)
        loss.backward()
        opt.step()
    metrics = evaluate(model, val, tokenizer.pad_id, weights, struct_ids, arg_weight, lambdas)
    metrics["mode"] = mode
    metrics["parameters"] = model.parameter_count()
    metrics["steps"] = steps
    metrics["wall_time_sec"] = round(time.monotonic() - started, 2)
    metrics["lambdas"] = {**lambdas, "arg_weight": arg_weight}
    print(json.dumps({k: metrics[k] for k in ("mode", "val_tool_accuracy", "val_task_accuracy", "val_loss")}))
    return metrics


def main() -> dict:
    parser = argparse.ArgumentParser()
    parser.add_argument("--max-steps", type=int, default=40)
    parser.add_argument("--seed", type=int, default=13)
    parser.add_argument("--out", default=None)
    args = parser.parse_args()

    train_rows = load_jsonl(DATA / "train.jsonl")
    val_rows = load_jsonl(DATA / "val.jsonl")
    if not train_rows:
        raise SystemExit("build SFT data first")
    corpus = [r["prompt"] + " " + r["completion"] for r in train_rows[:200] + val_rows]
    tokenizer = EduNovaTokenizer.train(corpus, vocab_size=1024)
    encoded_train = [encode_example_aligned(tokenizer, r, 128) for r in train_rows]
    encoded_val = [encode_example_aligned(tokenizer, r, 128) for r in val_rows]
    results = []
    for mode, lambdas in MODES.items():
        results.append(_run(mode, dict(lambdas), tokenizer, encoded_train, encoded_val, args.max_steps, args.seed))
    report = {
        "note": "Tiny diagnostic model. Not comparable to the 20M checkpoint.",
        "date": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "steps": args.max_steps,
        "results": results,
    }
    if args.out:
        path = Path(args.out)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(report, indent=2), encoding="utf-8")
        print("wrote", path)
    return report


if __name__ == "__main__":
    main()
