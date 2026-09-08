"""Token embeddings for EduNova HRM. Positions use RoPE, not learned tables."""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    import torch
    from torch import nn


def build_embeddings(config) -> "nn.Embedding":
    import torch.nn as nn

    emb = nn.Embedding(config.vocab_size, config.d_model, padding_idx=config.pad_id)
    nn.init.normal_(emb.weight, mean=0.0, std=0.02)
    if config.pad_id is not None:
        with torch_no_grad():
            emb.weight.data[config.pad_id].zero_()
    return emb


def torch_no_grad():
    import torch

    return torch.no_grad()
