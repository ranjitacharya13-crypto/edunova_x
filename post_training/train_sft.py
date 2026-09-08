#!/usr/bin/env python3
"""Supervised fine-tuning for the custom EduNova HRM (real gradient updates).

    python post_training/train_sft.py --config configs/model/20m.yaml --max-steps 300

Phase 2 alignment:
- tokenizer: edunova-tok-v2 (longest-match atomic structure tokens)
- encoder sees the chat prompt; decoder is teacher-forced on
  `<assistant> + completion`, and generate() starts at <assistant>
- loss: CE weighted 2.5 on structure tokens and (default 4.0) on tool-name
  tokens, plus head losses; metrics include structure-token accuracy
- class-balanced sampling by primary tool (anti mode-collapse)

--resume loads a checkpoint directory saved by this script (must be
edunova-tok-v2). Without --resume a fresh model is built from the config and
a fresh tok-v2 tokenizer is trained on the SFT corpus. tok-v1 weights are
never mixed with tok-v2.

Checkpoints are written under post_training/checkpoints/ and are gitignored.
"""

from __future__ import annotations

import argparse
import json
import random
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "ai_engine"))
sys.path.insert(0, str(ROOT / "training"))
sys.path.insert(0, str(ROOT / "post_training"))

from hrm.config import TOOL_NAMES, load_hrm_config  # noqa: E402
from hrm.hrm import EduNovaHRM  # noqa: E402
from hrm.tokenizer import EduNovaTokenizer  # noqa: E402
from preprocessing.prepare import encode_example_aligned, load_jsonl  # noqa: E402
from loss import (  # noqa: E402
    build_label_weights,
    structure_token_accuracy,
    structure_token_ids,
    weighted_lm_loss,
)

DATA_DIR = ROOT / "post_training" / "datasets" / "sft"
DEFAULT_OUT = ROOT / "post_training" / "checkpoints" / "edunova-hrm-20m-sft"


def _collate(rows: list[dict], pad_id: int):
    import torch

    enc_len = max(len(r["encoder_ids"]) for r in rows)
    dec_len = max(len(r["decoder_ids"]) for r in rows)

    def pad(seq, value, n):
        return seq + [value] * (n - len(seq))

    encoder = torch.tensor([pad(r["encoder_ids"], pad_id, enc_len) for r in rows], dtype=torch.long)
    decoder = torch.tensor([pad(r["decoder_ids"], pad_id, dec_len) for r in rows], dtype=torch.long)
    labels = torch.tensor([pad(r["labels"], -100, dec_len) for r in rows], dtype=torch.long)
    enc_mask = encoder.ne(pad_id).long()
    aux = {k: torch.tensor([r[k] for r in rows], dtype=torch.long) for k in ("task_id", "tool_id", "output_type_id")}
    return encoder, enc_mask, decoder, labels, aux


def evaluate(model, rows, pad_id, weights, struct_ids, batch_size: int = 8) -> dict:
    import torch
    import torch.nn.functional as F

    model.eval()
    total_loss, batches = 0.0, 0
    s_correct = s_total = 0
    tool_correct = task_correct = 0
    with torch.no_grad():
        for i in range(0, len(rows), batch_size):
            enc, enc_mask, dec, labels, aux = _collate(rows[i : i + batch_size], pad_id)
            out = model(enc, enc_mask, dec)
            logits = out["logits"][:, :-1].contiguous()
            shifted = labels[:, 1:].contiguous()
            loss = weighted_lm_loss(logits.view(-1, logits.size(-1)), shifted.view(-1), weights)
            tool_loss = F.cross_entropy(out["tool_logits"], aux["tool_id"])
            total_loss += float((loss + tool_loss).item())
            batches += 1
            acc = structure_token_accuracy(logits.view(-1, logits.size(-1)), shifted.view(-1), struct_ids)
            s_correct += acc["structure_correct"]
            s_total += acc["structure_total"]
            tool_correct += int((out["tool_logits"].argmax(-1) == aux["tool_id"]).sum().item())
            task_correct += int((out["task_logits"].argmax(-1) == aux["task_id"]).sum().item())
    n = max(1, len(rows))
    return {
        "val_loss": total_loss / max(1, batches),
        "val_structure_token_accuracy": (s_correct / s_total) if s_total else 0.0,
        "val_tool_accuracy": tool_correct / n,
        "val_task_accuracy": task_correct / n,
    }


class ClassBalancedSampler:
    """Each step: pick a primary-tool class uniformly at random, then a
    random row within it. Prevents high-frequency tools from dominating."""

    def __init__(self, rows: list[dict], batch_size: int, seed: int):
        self.batch_size = batch_size
        self.rng = random.Random(seed)
        self.by_tool: dict[int, list[int]] = {}
        for idx, row in enumerate(rows):
            self.by_tool.setdefault(int(row["tool_id"]), []).append(idx)
        self.classes = sorted(self.by_tool)

    def sample(self) -> list[int]:
        picks = []
        for _ in range(self.batch_size):
            cls = self.rng.choice(self.classes)
            picks.append(self.rng.choice(self.by_tool[cls]))
        return picks


def main() -> dict:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", default=str(ROOT / "configs" / "model" / "20m.yaml"))
    parser.add_argument("--data", default=str(DATA_DIR))
    parser.add_argument("--output", default=str(DEFAULT_OUT))
    parser.add_argument("--max-steps", type=int, default=300)
    parser.add_argument("--batch-size", type=int, default=4)
    parser.add_argument("--lr", type=float, default=3e-4)
    parser.add_argument("--weight-decay", type=float, default=0.01)
    parser.add_argument("--grad-clip", type=float, default=1.0)
    parser.add_argument("--warmup-steps", type=int, default=10)
    parser.add_argument("--structure-weight", type=float, default=2.5)
    parser.add_argument("--tool-weight", type=float, default=4.0)
    parser.add_argument("--seed", type=int, default=13)
    parser.add_argument("--resume", default=None, help="checkpoint dir saved by this script (edunova-tok-v2 only)")
    args = parser.parse_args()

    import torch
    import torch.nn.functional as F

    torch.manual_seed(args.seed)
    cfg = load_hrm_config(args.config)
    data_dir = Path(args.data)
    train_rows = load_jsonl(data_dir / "train.jsonl")
    val_rows = load_jsonl(data_dir / "val.jsonl")
    if not train_rows:
        raise SystemExit("SFT training data is empty; run build_sft.py first")

    if args.resume:
        ckpt = Path(args.resume)
        tokenizer = EduNovaTokenizer.load(ckpt)
        if tokenizer.version != "edunova-tok-v2":
            raise SystemExit(f"Refusing to resume: tokenizer is {tokenizer.version}, need edunova-tok-v2")
        model = EduNovaHRM.from_pretrained(ckpt)
        cfg = model.config
        print(f"resumed from {ckpt} (params={model.parameter_count()})")
    else:
        corpus = [r["prompt"] + " " + r["completion"] for r in train_rows + val_rows]
        tokenizer = EduNovaTokenizer.train(corpus, vocab_size=cfg.vocab_size)
        cfg.vocab_size = tokenizer.vocab_size
        model = EduNovaHRM(cfg)
        print(f"fresh model params={model.parameter_count()} vocab={tokenizer.vocab_size} tok={tokenizer.version}")

    device = torch.device("cpu")
    model.to(device)
    encoded_train = [encode_example_aligned(tokenizer, r, cfg.max_seq_len) for r in train_rows]
    encoded_val = [encode_example_aligned(tokenizer, r, cfg.max_seq_len) for r in val_rows]

    weights = build_label_weights(tokenizer, args.structure_weight, args.tool_weight, vocab_size=cfg.vocab_size)
    struct_ids = structure_token_ids(tokenizer)
    sampler = ClassBalancedSampler(encoded_train, args.batch_size, args.seed)
    opt = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=args.weight_decay)

    def lr_at(step: int) -> float:
        if step < args.warmup_steps:
            return args.lr * (step + 1) / args.warmup_steps
        return args.lr

    model.train()
    started = time.monotonic()
    step = 0
    running = 0.0
    running_struct_correct = running_struct_total = 0
    history = []
    while step < args.max_steps:
        for group in opt.param_groups:
            group["lr"] = lr_at(step)
        idx = sampler.sample()
        enc, enc_mask, dec, labels, aux = _collate([encoded_train[i] for i in idx], tokenizer.pad_id)
        out = model(enc, enc_mask, dec)
        logits = out["logits"][:, :-1].contiguous()
        shifted = labels[:, 1:].contiguous()
        lm = weighted_lm_loss(logits.view(-1, logits.size(-1)), shifted.view(-1), weights)
        task = F.cross_entropy(out["task_logits"], aux["task_id"])
        tool = F.cross_entropy(out["tool_logits"], aux["tool_id"])
        out_t = F.cross_entropy(out["output_type_logits"], aux["output_type_id"])
        loss = lm + 0.5 * task + 1.0 * tool + 0.5 * out_t
        opt.zero_grad(set_to_none=True)
        loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), args.grad_clip)
        opt.step()
        running += float(loss.item())
        acc = structure_token_accuracy(logits.view(-1, logits.size(-1)).detach(), shifted.view(-1), struct_ids)
        running_struct_correct += acc["structure_correct"]
        running_struct_total += acc["structure_total"]
        step += 1
        if step % 50 == 0 or step == args.max_steps:
            metrics = evaluate(model, encoded_val, tokenizer.pad_id, weights, struct_ids)
            metrics["step"] = step
            metrics["train_loss_avg"] = running / step
            metrics["train_structure_token_accuracy"] = (
                running_struct_correct / running_struct_total if running_struct_total else 0.0
            )
            history.append(metrics)
            print(json.dumps(metrics))
            model.train()

    out_dir = Path(args.output)
    model.save_pretrained(out_dir, tokenizer=tokenizer)
    final = evaluate(model, encoded_val, tokenizer.pad_id, weights, struct_ids)
    metrics = {
        "stage": "sft",
        "tokenizer_version": tokenizer.version,
        "resumed_from": args.resume,
        "config": str(args.config),
        "parameters": model.parameter_count(),
        "steps": step,
        "batch_size": args.batch_size,
        "lr": args.lr,
        "structure_weight": args.structure_weight,
        "tool_weight": args.tool_weight,
        "class_balanced_sampling": True,
        "train_rows": len(encoded_train),
        "val_rows": len(encoded_val),
        "train_loss_avg": running / max(1, step),
        "train_structure_token_accuracy": (running_struct_correct / running_struct_total) if running_struct_total else 0.0,
        **final,
        "wall_time_sec": round(time.monotonic() - started, 1),
        "device": "cpu",
        "history": history,
    }
    (out_dir / "sft_metrics.json").write_text(json.dumps(metrics, indent=2), encoding="utf-8")
    print("saved", out_dir)
    return metrics


if __name__ == "__main__":
    main()
