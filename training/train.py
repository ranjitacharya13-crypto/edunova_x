#!/usr/bin/env python3
"""Real EduNova HRM training. Metrics come from actual optimization, not prints.

    python training/train.py --config configs/model/20m.yaml
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "ai_engine"))
sys.path.insert(0, str(ROOT / "training"))

from datasets.generate_synthetic import write_splits  # noqa: E402
from hrm.config import load_hrm_config  # noqa: E402
from hrm.hrm import EduNovaHRM  # noqa: E402
from hrm.tokenizer import EduNovaTokenizer  # noqa: E402
from preprocessing.prepare import encode_example, load_jsonl  # noqa: E402


def _collate(batch, pad_id: int):
    import torch

    max_len = max(len(x["input_ids"]) for x in batch)
    def pad(seq, value):
        return seq + [value] * (max_len - len(seq))
    input_ids = torch.tensor([pad(x["input_ids"], pad_id) for x in batch], dtype=torch.long)
    labels = torch.tensor([pad(x["labels"], -100) for x in batch], dtype=torch.long)
    attention = input_ids.ne(pad_id).long()
    task = torch.tensor([x["task_id"] for x in batch], dtype=torch.long)
    tool = torch.tensor([x["tool_id"] for x in batch], dtype=torch.long)
    out_t = torch.tensor([x["output_type_id"] for x in batch], dtype=torch.long)
    need = torch.tensor([x["need_tools"] for x in batch], dtype=torch.long)
    return {
        "input_ids": input_ids,
        "attention_mask": attention,
        "decoder_input_ids": input_ids,
        "labels": labels,
        "task_id": task,
        "tool_id": tool,
        "output_type_id": out_t,
        "need_tools": need,
    }


def evaluate(model, encoded, pad_id: int, batch_size: int = 4) -> dict[str, float]:
    import torch
    import torch.nn.functional as F

    model.eval()
    total_loss = 0.0
    n = 0
    task_correct = tool_correct = 0
    with torch.no_grad():
        for i in range(0, len(encoded), batch_size):
            batch = _collate(encoded[i : i + batch_size], pad_id)
            out = model(batch["input_ids"], batch["attention_mask"], batch["decoder_input_ids"])
            logits = out["logits"][:, :-1].contiguous()
            labels = batch["labels"][:, 1:].contiguous()
            lm = F.cross_entropy(logits.view(-1, logits.size(-1)), labels.view(-1), ignore_index=-100)
            task = F.cross_entropy(out["task_logits"], batch["task_id"])
            tool = F.cross_entropy(out["tool_logits"], batch["tool_id"])
            total_loss += float((lm + task + tool).item())
            n += 1
            task_correct += int((out["task_logits"].argmax(-1) == batch["task_id"]).sum().item())
            tool_correct += int((out["tool_logits"].argmax(-1) == batch["tool_id"]).sum().item())
    denom = max(1, n)
    count = max(1, len(encoded))
    return {
        "val_loss": total_loss / denom,
        "task_accuracy": task_correct / count,
        "tool_accuracy": tool_correct / count,
    }


def train(config_path: str, max_steps: int | None = None, output_dir: str | None = None) -> dict:
    import torch
    import torch.nn.functional as F

    cfg = load_hrm_config(config_path)
    data_dir = ROOT / "training" / "datasets"
    write_splits(data_dir)
    train_rows = load_jsonl(data_dir / "train.jsonl")
    val_rows = load_jsonl(data_dir / "val.jsonl")
    texts = [r["prompt"] + " " + r["completion"] for r in train_rows + val_rows]
    tokenizer = EduNovaTokenizer.train(texts, vocab_size=cfg.vocab_size)
    cfg.vocab_size = tokenizer.vocab_size
    encoded_train = [encode_example(tokenizer, r, cfg.max_seq_len) for r in train_rows]
    encoded_val = [encode_example(tokenizer, r, cfg.max_seq_len) for r in val_rows]
    model = EduNovaHRM(cfg)
    device = torch.device("cpu")
    model.to(device)
    params = model.parameter_count()
    opt = torch.optim.AdamW(model.parameters(), lr=float(_yaml_num(config_path, "lr", 3e-4)), weight_decay=0.01)
    batch_size = int(_yaml_num(config_path, "batch_size", 4))
    steps_limit = max_steps if max_steps is not None else int(_yaml_num(config_path, "max_steps", 50))
    grad_clip = float(_yaml_num(config_path, "grad_clip", 1.0))
    model.train()
    started = time.monotonic()
    step = 0
    running = 0.0
    peak_rss = _rss_mb()
    while step < steps_limit:
        for i in range(0, len(encoded_train), batch_size):
            if step >= steps_limit:
                break
            batch = _collate(encoded_train[i : i + batch_size], tokenizer.pad_id)
            batch = {k: v.to(device) if hasattr(v, "to") else v for k, v in batch.items()}
            out = model(batch["input_ids"], batch["attention_mask"], batch["decoder_input_ids"])
            logits = out["logits"][:, :-1].contiguous()
            labels = batch["labels"][:, 1:].contiguous()
            lm_loss = F.cross_entropy(logits.view(-1, logits.size(-1)), labels.view(-1), ignore_index=-100)
            task_loss = F.cross_entropy(out["task_logits"], batch["task_id"])
            tool_loss = F.cross_entropy(out["tool_logits"], batch["tool_id"])
            type_loss = F.cross_entropy(out["output_type_logits"], batch["output_type_id"])
            need_loss = F.cross_entropy(out["need_tools_logits"], batch["need_tools"])
            loss = lm_loss + task_loss + tool_loss + 0.5 * type_loss + 0.5 * need_loss
            opt.zero_grad(set_to_none=True)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), grad_clip)
            opt.step()
            running += float(loss.item())
            step += 1
            peak_rss = max(peak_rss, _rss_mb())
    train_seconds = time.monotonic() - started
    metrics = evaluate(model, encoded_val or encoded_train[-4:], tokenizer.pad_id, batch_size)
    out_dir = Path(output_dir or ROOT / "training" / "checkpoints" / cfg.name)
    tokenizer.save(out_dir)
    model.save_pretrained(out_dir, tokenizer=tokenizer)
    report = {
        "model": cfg.name,
        "architecture_version": cfg.architecture_version,
        "tokenizer_version": tokenizer.version,
        "parameter_count": params,
        "disk_bytes": (out_dir / "pytorch_model.pt").stat().st_size,
        "steps": step,
        "train_loss_avg": running / max(1, step),
        "train_seconds": round(train_seconds, 3),
        "steps_per_second": round(step / max(train_seconds, 1e-6), 4),
        "peak_rss_mb": peak_rss,
        **metrics,
        "dataset": "edunova-hrm-synthetic-v1",
        "stage": "pretrain",
    }
    (out_dir / "train_metrics.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, indent=2))
    return report


def _yaml_num(path: str, key: str, default: float) -> float:
    for line in Path(path).read_text(encoding="utf-8").splitlines():
        if line.strip().startswith(f"{key}:"):
            try:
                return float(line.split(":", 1)[1].strip())
            except ValueError:
                return default
    return default


def _rss_mb() -> float:
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
    parser.add_argument("--config", default=str(ROOT / "configs" / "model" / "20m.yaml"))
    parser.add_argument("--max-steps", type=int, default=None)
    parser.add_argument("--output", default=None)
    args = parser.parse_args()
    train(args.config, max_steps=args.max_steps, output_dir=args.output)


if __name__ == "__main__":
    main()
