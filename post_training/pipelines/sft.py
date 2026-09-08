"""Supervised fine-tuning on instruction/tool data. Real gradient updates."""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "ai_engine"))
sys.path.insert(0, str(ROOT / "training"))


def sft(checkpoint: str, data_path: str, output: str, steps: int = 20, lr: float = 5e-5) -> dict:
    import torch
    import torch.nn.functional as F

    from hrm.hrm import EduNovaHRM
    from hrm.tokenizer import EduNovaTokenizer
    from preprocessing.prepare import encode_example, load_jsonl
    from train import _collate

    model = EduNovaHRM.from_pretrained(checkpoint)
    tokenizer = EduNovaTokenizer.load(checkpoint)
    rows = load_jsonl(Path(data_path))
    encoded = [encode_example(tokenizer, r, model.config.max_seq_len) for r in rows]
    if not encoded:
        raise ValueError("SFT dataset is empty")
    for p in model.parameters():
        p.requires_grad = True
    opt = torch.optim.AdamW((p for p in model.parameters() if p.requires_grad), lr=lr)
    model.train()
    step = 0
    total = 0.0
    while step < steps:
        for i in range(0, len(encoded), 2):
            if step >= steps:
                break
            batch = _collate(encoded[i : i + 2], tokenizer.pad_id)
            out = model(batch["input_ids"], batch["attention_mask"], batch["decoder_input_ids"])
            logits = out["logits"][:, :-1].contiguous()
            labels = batch["labels"][:, 1:].contiguous()
            loss = F.cross_entropy(logits.view(-1, logits.size(-1)), labels.view(-1), ignore_index=-100)
            loss = loss + F.cross_entropy(out["tool_logits"], batch["tool_id"])
            opt.zero_grad(set_to_none=True)
            loss.backward()
            opt.step()
            total += float(loss.item())
            step += 1
    out_dir = Path(output)
    model.save_pretrained(out_dir, tokenizer=tokenizer)
    metrics = {"steps": step, "sft_loss_avg": total / max(1, step), "parent": checkpoint, "method": "full_sft"}
    (out_dir / "sft_metrics.json").write_text(json.dumps(metrics, indent=2), encoding="utf-8")
    return metrics
