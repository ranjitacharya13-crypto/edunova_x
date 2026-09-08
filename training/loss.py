"""Weighted LM loss and structure metrics for EduNova HRM SFT.

Byte tokens dominate the sequence but carry no syntax; the tokens that
decide whether an output parses as the EduNova protocol are the structure
tokens (output-type markers, JSON wrappers/fields, tool names, specials).
Phase-2 diagnosis showed plain CE under-weights exactly those positions, so
we up-weight them and measure accuracy on them separately.

Phase 4 adds:
- argument-span upweighting (correct tool + wrong args is still a failure)
- a documented multitask combination with explicit lambdas
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
DEFAULT_ARG_WEIGHT = 3.0

# Multitask lambdas. Chosen from the 80-step ablation in
# docs/phase4-training.md; not guessed at promotion time.
DEFAULT_LAMBDA_TOOL = 2.0
DEFAULT_LAMBDA_OUTPUT = 0.75
DEFAULT_LAMBDA_TASK = 0.5
DEFAULT_LAMBDA_NEED = 0.25
DEFAULT_LAMBDA_STRUCTURE = 1.0  # already in token weights; kept for reporting
DEFAULT_LAMBDA_ARGS = 1.0       # already in token weights; kept for reporting


def structure_token_ids(tokenizer) -> set[int]:
    ids: list[int] = []
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
    ids: list[int] = []
    for text in TOOL_TOKENS:
        token_id = tokenizer.token_to_id.get(text)
        if token_id is not None:
            ids.append(token_id)
    return set(ids)


def arguments_wrapper_id(tokenizer) -> int | None:
    return tokenizer.token_to_id.get('","arguments":')


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


def apply_argument_span_weight(weights_row, labels_row, wrapper_id: int | None, arg_weight: float):
    """Up-weight tokens after the arguments wrapper on this sequence.

    weights_row is a 1-D tensor aligned with labels_row. Positions whose
    gold token is -100 are ignored by CE anyway.
    """
    if wrapper_id is None or arg_weight <= 1.0:
        return weights_row
    import torch

    hits = (labels_row == int(wrapper_id)).nonzero(as_tuple=False)
    if hits.numel() == 0:
        return weights_row
    start = int(hits[0].item()) + 1
    if start < labels_row.numel():
        span = labels_row[start:]
        live = span.ne(-100)
        weights_row[start:][live] = torch.clamp(weights_row[start:][live], min=float(arg_weight))
    return weights_row


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


def weighted_lm_loss_with_args(
    logits,
    labels,
    class_weights,
    arg_mask=None,
    arg_weight: float = DEFAULT_ARG_WEIGHT,
    ignore_index: int = -100,
):
    """CE with class weights plus an optional per-position argument mask.

    arg_mask: same shape as labels, 1 where the gold token is inside the
    arguments object. Those positions are multiplied by arg_weight on top
    of the class weight.
    """
    import torch
    import torch.nn.functional as F

    vocab = logits.size(-1)
    flat_logits = logits.view(-1, vocab)
    flat_labels = labels.view(-1)
    loss = F.cross_entropy(
        flat_logits,
        flat_labels,
        weight=class_weights.to(logits.device),
        ignore_index=ignore_index,
        reduction="none",
    )
    if arg_mask is not None and arg_weight and arg_weight != 1.0:
        pos_w = torch.ones_like(loss)
        mask = arg_mask.reshape(-1).to(loss.dtype)
        pos_w = pos_w + mask * (float(arg_weight) - 1.0)
        live = flat_labels.ne(ignore_index).to(loss.dtype)
        denom = (pos_w * live).sum().clamp(min=1.0)
        return (loss * pos_w).sum() / denom
    live = flat_labels.ne(ignore_index)
    return loss[live].mean() if int(live.sum().item()) else loss.mean()


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


def combine_multitask(
    lm,
    tool,
    output,
    task,
    need=None,
    *,
    lambda_tool: float = DEFAULT_LAMBDA_TOOL,
    lambda_output: float = DEFAULT_LAMBDA_OUTPUT,
    lambda_task: float = DEFAULT_LAMBDA_TASK,
    lambda_need: float = DEFAULT_LAMBDA_NEED,
):
    """L_total = L_language + λ_tool L_tool + λ_output L_output + λ_task L_task + λ_need L_need."""
    total = lm + lambda_tool * tool + lambda_output * output + lambda_task * task
    if need is not None:
        total = total + lambda_need * need
    return total
