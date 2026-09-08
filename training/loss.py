"""Weighted LM loss and structure metrics for EduNova HRM SFT.

Byte tokens dominate the sequence but carry no syntax; the tokens that
decide whether an output parses as the EduNova protocol are the structure
tokens (output-type markers, JSON wrappers/fields, tool names, specials).
Phase-2 diagnosis showed plain CE under-weights exactly those positions, so
we up-weight them and measure accuracy on them separately.
"""

from __future__ import annotations

from typing import Iterable

from hrm.tokenizer.specials import (
    JSON_FIELD_TOKENS,
    JSON_WRAPPER_TOKENS,
    SPECIAL_TOKENS,
    STRUCTURE_TOKENS,
    TOOL_TOKENS,
)

DEFAULT_STRUCTURE_WEIGHT = 2.5
DEFAULT_TOOL_WEIGHT = 4.0


def structure_token_ids(tokenizer) -> set[int]:
    ids: set[int] = []
    names = (
        list(SPECIAL_TOKENS)
        + list(STRUCTURE_TOKENS)
        + list(JSON_WRAPPER_TOKENS)
        + list(JSON_FIELD_TOKENS)
        + list(TOOL_TOKENS)
    )
    for text in names:
        token_id = tokenizer.token_to_id.get(text)
        if token_id is not None:
            ids.append(token_id)
    return set(ids)


def tool_token_ids(tokenizer) -> set[int]:
    ids: set[int] = []
    for text in TOOL_TOKENS:
        token_id = tokenizer.token_to_id.get(text)
        if token_id is not None:
            ids.append(token_id)
    return set(ids)


def build_label_weights(
    tokenizer,
    structure_weight: float = DEFAULT_STRUCTURE_WEIGHT,
    tool_weight: float = DEFAULT_TOOL_WEIGHT,
    vocab_size: int | None = None,
):
    """Per-vocab-id loss weights. Tool-name tokens get the tool weight
    (breaking the mode-collapse where the decoder always picks the single
    most frequent tool), other structure tokens get the structure weight."""
    import torch

    size = vocab_size or tokenizer.vocab_size
    weights = torch.ones(size, dtype=torch.float32)
    for token_id in structure_token_ids(tokenizer):
        weights[token_id] = float(structure_weight)
    for token_id in tool_token_ids(tokenizer):
        weights[token_id] = float(tool_weight)
    return weights


def weighted_lm_loss(logits, labels, weights, ignore_index: int = -100):
    """Cross-entropy with per-target-class weights (like nn.CrossEntropyLoss
    weight=). logits: (N, V), labels: (N,)."""
    import torch.nn.functional as F

    return F.cross_entropy(
        logits,
        labels,
        weight=weights.to(logits.device),
        ignore_index=ignore_index,
    )


def structure_token_accuracy(logits, labels, structure_ids: Iterable[int], ignore_index: int = -100) -> dict:
    """Accuracy restricted to positions whose gold token is a structure
    token, plus a dedicated tool-name subset. Returns counts so the caller
    can aggregate across batches without averaging artifacts."""
    import torch

    preds = logits.argmax(dim=-1)
    mask = labels.ne(ignore_index)
    device = labels.device
    struct_ids = torch.tensor(sorted(structure_ids), dtype=torch.long, device=device)
    gold_is_struct = (labels.unsqueeze(-1) == struct_ids).any(-1) & mask
    total = int(gold_is_struct.sum().item())
    correct = int(((preds == labels) & gold_is_struct).sum().item())
    return {
        "structure_correct": correct,
        "structure_total": total,
        "structure_accuracy": (correct / total) if total else 0.0,
    }
