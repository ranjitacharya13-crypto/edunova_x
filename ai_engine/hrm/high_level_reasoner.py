"""High-level reasoner: task type, tool routing, plan, continue/stop.

Operates as a bidirectional encoder over the prompt. Its pooled state
conditions the low-level decoder (shared weights live in EduNovaHRM).
"""

from __future__ import annotations

from .attention import FeedForward, MultiHeadAttention, RMSNorm, RotaryEmbedding
from .config import HRMConfig


def _torch():
    import torch
    import torch.nn as nn

    return torch, nn


class HighLevelBlock:
    def __new__(cls, config: HRMConfig):
        torch, nn = _torch()

        class _Block(nn.Module):
            def __init__(self):
                super().__init__()
                self.n1 = RMSNorm(config.d_model)
                self.attn = MultiHeadAttention(config.d_model, config.n_heads, config.dropout)
                self.n2 = RMSNorm(config.d_model)
                self.ffn = FeedForward(config.d_model, config.ffn_mult, config.dropout)

            def forward(self, x, attn_mask, rope):
                x = x + self.attn(self.n1(x), attn_mask=attn_mask, rope=rope)
                x = x + self.ffn(self.n2(x))
                return x

        return _Block()


class HighLevelReasoner:
    def __new__(cls, config: HRMConfig):
        torch, nn = _torch()

        class _HL(nn.Module):
            def __init__(self):
                super().__init__()
                self.config = config
                self.rope = RotaryEmbedding(config.d_model // config.n_heads, config.max_seq_len, config.rope_theta)
                self.layers = nn.ModuleList(HighLevelBlock(config) for _ in range(config.high_level_layers))
                self.final_norm = RMSNorm(config.d_model)
                self.summary = nn.Linear(config.d_model, config.d_model, bias=False)
                self.task_head = nn.Linear(config.d_model, config.n_task_types, bias=False)
                self.tool_head = nn.Linear(config.d_model, config.n_tools, bias=False)
                self.output_type_head = nn.Linear(config.d_model, config.n_output_types, bias=False)
                self.need_tools_head = nn.Linear(config.d_model, 2, bias=False)

            def forward(self, hidden, padding_mask=None):
                """hidden: (B, T, D). padding_mask: (B, T) True = keep."""
                b, t, _ = hidden.shape
                attn_mask = None
                if padding_mask is not None:
                    # (B, 1, 1, T) additive mask
                    attn_mask = torch.zeros(b, 1, 1, t, device=hidden.device, dtype=hidden.dtype)
                    attn_mask = attn_mask.masked_fill(~padding_mask.unsqueeze(1).unsqueeze(1), torch.finfo(hidden.dtype).min)
                x = hidden
                rope = self.rope
                if self.training and self.config.gradient_checkpointing:
                    from torch.utils.checkpoint import checkpoint

                    for layer in self.layers:
                        x = checkpoint(layer, x, attn_mask, rope, use_reentrant=False)
                else:
                    for layer in self.layers:
                        x = layer(x, attn_mask, rope)
                x = self.final_norm(x)
                if padding_mask is None:
                    pooled = x.mean(dim=1)
                else:
                    denom = padding_mask.sum(dim=1, keepdim=True).clamp(min=1)
                    pooled = (x * padding_mask.unsqueeze(-1)).sum(dim=1) / denom
                summary = self.summary(pooled)
                return {
                    "memory": x,
                    "pooled": pooled,
                    "summary": summary,
                    "task_logits": self.task_head(pooled),
                    "tool_logits": self.tool_head(pooled),
                    "output_type_logits": self.output_type_head(pooled),
                    "need_tools_logits": self.need_tools_head(pooled),
                }

        return _HL()
