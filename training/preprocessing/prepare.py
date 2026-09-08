"""Encode JSONL examples for HRM training."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from hrm.config import OUTPUT_TYPE_NAMES, TASK_TYPES, TOOL_NAMES


def load_jsonl(path: Path) -> list[dict[str, Any]]:
    rows = []
    with path.open(encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


def encode_example(tokenizer, row: dict[str, Any], max_seq_len: int) -> dict[str, Any]:
    prompt = str(row["prompt"])
    completion = str(row["completion"])
    ids = tokenizer.encode_chat("You are EduNova HRM.", prompt, assistant=completion)
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
