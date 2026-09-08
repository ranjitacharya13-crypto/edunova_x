#!/usr/bin/env python3
"""Export a trained checkpoint into the Hugging Face package directory."""

from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "ai_engine"))


def export(checkpoint: str, dest: str | None = None) -> Path:
    ckpt = Path(checkpoint)
    dest_path = Path(dest or ROOT / "huggingface" / "edunova-hrm")
    dest_path.mkdir(parents=True, exist_ok=True)
    for name in ("pytorch_model.pt", "config.json", "tokenizer.json", "train_metrics.json"):
        src = ckpt / name
        if src.exists():
            shutil.copy2(src, dest_path / name)
    card = ROOT / "huggingface" / "edunova-hrm" / "README.md"
    if not card.exists():
        pass
    print(json.dumps({"exported": str(dest_path), "files": [p.name for p in dest_path.iterdir()]}))
    return dest_path


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--checkpoint", required=True)
    parser.add_argument("--dest", default=None)
    args = parser.parse_args()
    export(args.checkpoint, args.dest)


if __name__ == "__main__":
    main()
