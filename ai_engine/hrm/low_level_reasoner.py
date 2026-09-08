"""Low-level reasoner: causal decoder conditioned on high-level memory.

Cross-attention lets the generator use the high-level plan/tool decision
while producing tokens (structured JSON or natural language).
"""

from __future__ import annotations

from .attention import FeedForward, MultiHeadAttention, RMSNorm, RotaryEmbedding
from .config import HRMConfig


def _torch():
    import torch
    import torch.nn as nn

    return torch, nn


class LowLevelBlock:
    def __new__(cls, config: HRMConfig):
        torch, nn = _torch()

        class _Block(nn.Module):
            def __init__(self):
                super().__init__()
                self.n1 = RMSNorm(config.d_model)
                self.self_attn = MultiHeadAttention(config.d_model, config.n_heads, config.dropout)
                self.n2 = RMSNorm(config.d_model)
                self.cross_attn = MultiHeadAttention(config.d_model, config.n_heads, config.dropout, is_cross=True)
                self.n3 = RMSNorm(config.d_model)
                self.ffn = FeedForward(config.d_model, config.ffn_mult, config.dropout)

            def forward(self, x, memory, causal_mask, memory_mask, rope, kv_cache=None):
                x = x + self.self_attn(self.n1(x), attn_mask=causal_mask, rope=rope, kv_cache=kv_cache)
                x = x + self.cross_attn(self.n2(x), context=memory, attn_mask=memory_mask)
                x = x + self.ffn(self.n3(x))
                return x

        return _Block()


class LowLevelReasoner:
    def __new__(cls, config: HRMConfig):
        torch, nn = _torch()

        class _LL(nn.Module):
            def __init__(self):
                super().__init__()
                self.config = config
                self.rope = RotaryEmbedding(config.d_model // config.n_heads, config.max_seq_len, config.rope_theta)
                self.layers = nn.ModuleList(LowLevelBlock(config) for _ in range(config.low_level_layers))
                self.final_norm = RMSNorm(config.d_model)
                self.lm_head = None if config.tie_embeddings else nn.Linear(config.d_model, config.vocab_size, bias=False)

            def _causal_mask(self, t: int, device, dtype, offset: int = 0):
                # For cached decode, t is 1 and offset is past length.
                total = offset + t
                mask = torch.full((total, total), torch.finfo(dtype).min, device=device, dtype=dtype)
                mask = torch.triu(mask, diagonal=1)
                return mask[-t:, :].unsqueeze(0).unsqueeze(0)

            def forward(
                self,
                hidden,
                memory,
                memory_padding=None,
                kv_caches=None,
                embedding_weight=None,
            ):
                torch, _ = _torch()
                b, t, _ = hidden.shape
                offset = 0
                if kv_caches and kv_caches[0].get("k") is not None:
                    offset = kv_caches[0]["k"].size(-2)
                causal = self._causal_mask(t, hidden.device, hidden.dtype, offset)
                mem_mask = None
                if memory_padding is not None:
                    mem_mask = torch.zeros(
                        memory.size(0), 1, 1, memory.size(1), device=hidden.device, dtype=hidden.dtype
                    )
                    mem_mask = mem_mask.masked_fill(
                        ~memory_padding.unsqueeze(1).unsqueeze(1), torch.finfo(hidden.dtype).min
                    )
                x = hidden
                rope = self.rope
                for i, layer in enumerate(self.layers):
                    cache = None if kv_caches is None else kv_caches[i]
                    if self.training and self.config.gradient_checkpointing and kv_caches is None:
                        from torch.utils.checkpoint import checkpoint

                        x = checkpoint(layer, x, memory, causal, mem_mask, rope, cache, use_reentrant=False)
                    else:
                        x = layer(x, memory, causal, mem_mask, rope, cache)
                x = self.final_norm(x)
                if self.lm_head is None:
                    if embedding_weight is None:
                        raise RuntimeError("tied embeddings require embedding_weight")
                    logits = torch.nn.functional.linear(x, embedding_weight)
                else:
                    logits = self.lm_head(x)
                return {"hidden": x, "logits": logits}

        return _LL()
