"""Build a tiny *real* PyTorch model directory for offline runtime tests.

No HuggingFace download happens here — everything is generated locally, so the
full inference pipeline (torch.inference_mode, KV cache streaming, int8
dynamic quantization path, chat template, tokenizer round-trips) can be
verified end-to-end in environments where huggingface.co is unreachable.

The model is intentionally tiny (a 2-layer BERT-LM decoder with ~30k params)
— it is for exercising the *pipeline*, never for answer quality.

Usage:
    python -m tests.tools.make_tiny_torch /path/to/model_dir
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

_SYSTEM_PROMPT_TOKEN = "[SYS]"
_USER_PROMPT_TOKEN = "[USR]"
_END_TOKEN = "[END]"
_SPECIAL_TOKENS = ["[PAD]", "[UNK]", "[CLS]", "[SEP]", "[MASK]", _END_TOKEN]
_VOCAB_WORDS = [
    "ok", "yes", "hello", "machine", "learning", "ai", "education", "study",
    "answer", "edunova", "the", "is", "a", "of", "and", "to", "in", "you",
    "what", "ml", "tamil", "timetable", "teacher", "student",
]


def _vocab() -> dict[str, int]:
    words = list(_SPECIAL_TOKENS) + _VOCAB_WORDS
    words += [chr(code) for code in range(ord("a"), ord("z") + 1)]
    words += [chr(code) for code in range(ord("0"), ord("9") + 1)]
    seen: dict[str, int] = {}
    for word in words:
        if word not in seen:
            seen[word] = len(seen)
    return seen


def build(target: Path) -> Path:
    import torch  # noqa: PLC0415
    from transformers import BertConfig, BertLMHeadModel, BertTokenizer  # noqa: PLC0415

    target = Path(target)
    target.mkdir(parents=True, exist_ok=True)
    vocab = _vocab()

    # vocab.txt for BertTokenizer (wordpiece; no merges needed).
    vocab_lines = sorted(vocab, key=lambda token: vocab[token])
    (target / "vocab.txt").write_text("\n".join(vocab_lines) + "\n", encoding="utf-8")
    (target / "tokenizer_config.json").write_text(
        json.dumps({"tokenizer_class": "BertTokenizer", "model_max_length": 1024}),
        encoding="utf-8",
    )

    config = BertConfig(
        vocab_size=len(vocab),
        hidden_size=48,
        num_hidden_layers=2,
        num_attention_heads=4,  # 48 / 12 heads? use 4 -> 12 dim/head
        intermediate_size=96,
        max_position_embeddings=512,
        is_decoder=True,
        add_cross_attention=False,
        pad_token_id=vocab["[PAD]"],
        bos_token_id=vocab["[CLS]"],
        eos_token_id=vocab["[SEP]"],
        architectures=["BertLMHeadModel"],
        model_type="bert",
    )
    config.architectures = ["BertLMHeadModel"]
    config.eos_token_id = vocab["[END]"]

    tokenizer = BertTokenizer(
        vocab_file=str(target / "vocab.txt"),
        do_lower_case=True,
        unk_token="[UNK]",
        pad_token="[PAD]",
        cls_token="[CLS]",
        sep_token="[SEP]",
        mask_token="[MASK]",
    )
    torch.manual_seed(7)
    model = BertLMHeadModel(config)
    tokenizer.save_pretrained(str(target))
    config.save_pretrained(str(target))
    # torch.save through transformers save_pretrained (safetensors optional)
    model.save_pretrained(str(target), safe_serialization=True)
    return target


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("target", nargs="?", default="ai_engine/tests/tmp_tiny_torch")
    args = parser.parse_args()
    target = build(Path(args.target))
    print(f"TINY_TORCH_MODEL_READY path={target.resolve()}")


if __name__ == "__main__":
    sys.exit(main())
