"""Encode JSONL examples for HRM training.

Phase 2 alignment fix: the model is an encoder/decoder. The encoder must see
the chat *prompt* (system/user, ending at <assistant>) and the decoder must
be teacher-forced on `<assistant> + completion`. Phase 1 fed the whole chat
through both sides and started generate() at <bos>, so inference never
matched training.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from hrm.config import OUTPUT_TYPE_NAMES, TASK_TYPES, TOOL_NAMES

SYSTEM_PROMPT = "You are EduNova HRM."


def load_jsonl(path: Path) -> list[dict[str, Any]]:
    rows = []
    with path.open(encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


def encode_example(tokenizer, row: dict[str, Any], max_seq_len: int) -> dict[str, Any]:
    """Legacy single-stream encoding (kept for training/train.py pretrain)."""
    prompt = str(row["prompt"])
    completion = str(row["completion"])
    ids = tokenizer.encode_chat(SYSTEM_PROMPT, prompt, assistant=completion)
    ids = ids[:max_seq_len]
    labels = list(ids)
    # Mask prompt tokens (everything before <assistant>) for LM loss.
    assistant_id = tokenizer.token_to_id.get("<assistant>")
    if assistant_id in ids:
        cut = ids.index(assistant_id) + 1
        labels = [-100] * cut + ids[cut:]
    task = str(row.get("task_type") or "EXPLANATION")
    tools = row.get("tools") or []
    primary = tools[0] if tools else "none"
    output_type = str(row.get("output_type") or "FINAL_ANSWER")
    return {
        "input_ids": ids,
        "labels": labels,
        "task_id": TASK_TYPES.index(task) if task in TASK_TYPES else TASK_TYPES.index("EXPLANATION"),
        "tool_id": TOOL_NAMES.index(primary) if primary in TOOL_NAMES else 0,
        "output_type_id": OUTPUT_TYPE_NAMES.index(output_type) if output_type in OUTPUT_TYPE_NAMES else 0,
        "need_tools": 1 if row.get("need_tools") or tools else 0,
    }


def encode_completion(tokenizer, completion: str) -> tuple[list[int], list[int]]:
    """Decoder sequence and labels for one completion.

    decoder_input = [<assistant>, c1..cn, <eos>]
    labels        = [-100(mask <assistant>), c1..cn, <eos>]
    After the caller's standard shift (logits[:, :-1] vs labels[:, 1:]) the
    model learns P(c1 | prompt, <assistant>) — identical to generate() which
    feeds <assistant> as the first decoder token.
    """
    assistant_id = tokenizer.token_to_id["<assistant>"]
    body = tokenizer.encode(completion)
    decoder_ids = [assistant_id] + body + [tokenizer.eos_id]
    labels = [-100] + body + [tokenizer.eos_id]
    return decoder_ids, labels


def _argument_mask(labels: list[int], tokenizer) -> list[int]:
    """1 on decoder label positions inside the JSON arguments object."""
    wrapper_id = tokenizer.token_to_id.get('","arguments":')
    mask = [0] * len(labels)
    if wrapper_id is None:
        return mask
    try:
        start = labels.index(wrapper_id) + 1
    except ValueError:
        return mask
    for i in range(start, len(labels)):
        if labels[i] != -100:
            mask[i] = 1
    return mask


def encode_example_aligned(tokenizer, row: dict[str, Any], max_seq_len: int) -> dict[str, Any]:
    """SFT encoding with encoder/decoder split (Phase 2).

    encoder_ids = <bos><system>..</system><user>prompt</user><assistant>
    decoder_ids / labels as in encode_completion (truncated to max_seq_len).
    """
    prompt = str(row["prompt"])
    completion = str(row["completion"])
    encoder_ids = tokenizer.prompt_ids(SYSTEM_PROMPT, prompt)[:max_seq_len]
    decoder_ids, labels = encode_completion(tokenizer, completion)
    decoder_ids = decoder_ids[:max_seq_len]
    labels = labels[:max_seq_len]
    task = str(row.get("task_type") or "EXPLANATION")
    tools = row.get("tools") or []
    primary = tools[0] if tools else "none"
    output_type = str(row.get("output_type") or "FINAL_ANSWER")
    stage = int(row.get("stage") or 1)
    return {
        "encoder_ids": encoder_ids,
        "decoder_ids": decoder_ids,
        "labels": labels,
        "arg_mask": _argument_mask(labels, tokenizer),
        "task_id": TASK_TYPES.index(task) if task in TASK_TYPES else TASK_TYPES.index("EXPLANATION"),
        "tool_id": TOOL_NAMES.index(primary) if primary in TOOL_NAMES else 0,
        "output_type_id": OUTPUT_TYPE_NAMES.index(output_type) if output_type in OUTPUT_TYPE_NAMES else 0,
        "need_tools": 1 if row.get("need_tools") or tools else 0,
        "stage": stage,
    }
