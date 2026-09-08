"""CPU-friendly multi-head attention with RoPE and optional KV cache.

No flash-attention dependency. Dropout is off by default for inference.
"""

from __future__ import annotations

from typing import Any


def _torch():
    import torch
    import torch.nn as nn
    import torch.nn.functional as F

    return torch, nn, F


def rotate_half(x):
    torch, _, _ = _torch()
    x1, x2 = x.chunk(2, dim=-1)
    return torch.cat((-x2, x1), dim=-1)


def apply_rope(q, k, cos, sin):
    # q,k: (B, H, T, D)  cos/sin: (T, D)
    cos = cos.unsqueeze(0).unsqueeze(0)
    sin = sin.unsqueeze(0).unsqueeze(0)
    q_len = q.size(-2)
    k_len = k.size(-2)
    q = (q * cos[:, :, -q_len:]) + (rotate_half(q) * sin[:, :, -q_len:])
    k = (k * cos[:, :, -k_len:]) + (rotate_half(k) * sin[:, :, -k_len:])
    return q, k


class RMSNorm:
    """Factory returning a real nn.Module."""

    def __new__(cls, d_model: int, eps: float = 1e-6):
        torch, nn, _ = _torch()

        class _RMSNorm(nn.Module):
            def __init__(self):
                super().__init__()
                self.weight = nn.Parameter(torch.ones(d_model))
                self.eps = eps

            def forward(self, x):
                norm = x.float().pow(2).mean(-1, keepdim=True)
                x = x * torch.rsqrt(norm + self.eps)
                return (self.weight * x).to(x.dtype)

        return _RMSNorm()


class RotaryEmbedding:
    def __new__(cls, head_dim: int, max_seq_len: int, theta: float = 10000.0):
        torch, nn, _ = _torch()

        class _Rotary(nn.Module):
            def __init__(self):
                super().__init__()
                inv = 1.0 / (theta ** (torch.arange(0, head_dim, 2).float() / head_dim))
                t = torch.arange(max_seq_len).float()
                freqs = torch.outer(t, inv)
                cos = torch.cos(freqs)
                sin = torch.sin(freqs)
                # interleave to head_dim
                cos = torch.stack((cos, cos), dim=-1).reshape(max_seq_len, head_dim)
                sin = torch.stack((sin, sin), dim=-1).reshape(max_seq_len, head_dim)
                self.register_buffer("cos", cos, persistent=False)
                self.register_buffer("sin", sin, persistent=False)

            def forward(self, seq_len: int, offset: int = 0):
                end = offset + seq_len
                return self.cos[offset:end], self.sin[offset:end]

        return _Rotary()


class MultiHeadAttention:
    def __new__(cls, d_model: int, n_heads: int, dropout: float = 0.0, is_cross: bool = False):
        torch, nn, F = _torch()
        if d_model % n_heads != 0:
            raise ValueError("d_model must be divisible by n_heads")
        head_dim = d_model // n_heads

        class _MHA(nn.Module):
            def __init__(self):
                super().__init__()
                self.n_heads = n_heads
                self.head_dim = head_dim
                self.is_cross = is_cross
                self.q_proj = nn.Linear(d_model, d_model, bias=False)
                self.k_proj = nn.Linear(d_model, d_model, bias=False)
                self.v_proj = nn.Linear(d_model, d_model, bias=False)
                self.o_proj = nn.Linear(d_model, d_model, bias=False)
                self.drop = nn.Dropout(dropout)

            def _shape(self, x, b: int, t: int):
                return x.view(b, t, self.n_heads, self.head_dim).transpose(1, 2)

            def forward(
                self,
                x,
                context=None,
                attn_mask=None,
                rope=None,
                kv_cache: dict[str, Any] | None = None,
            ):
                b, t, _ = x.shape
                q = self._shape(self.q_proj(x), b, t)
                src = context if (self.is_cross and context is not None) else x
                s = src.size(1)
                k = self._shape(self.k_proj(src), b, s)
                v = self._shape(self.v_proj(src), b, s)
                offset = 0
                if kv_cache is not None and not self.is_cross:
                    offset = 0 if kv_cache.get("k") is None else kv_cache["k"].size(-2)
                if rope is not None and not self.is_cross:
                    cos, sin = rope(t if kv_cache is None or kv_cache.get("k") is None else t, offset)
                    q, k = apply_rope(q, k, cos, sin)
                if kv_cache is not None and not self.is_cross:
                    if kv_cache.get("k") is not None:
                        k = torch.cat([kv_cache["k"], k], dim=-2)
                        v = torch.cat([kv_cache["v"], v], dim=-2)
                    kv_cache["k"], kv_cache["v"] = k, v
                scale = self.head_dim ** -0.5
                scores = torch.matmul(q, k.transpose(-2, -1)) * scale
                if attn_mask is not None:
                    scores = scores + attn_mask
                probs = F.softmax(scores.float(), dim=-1).to(q.dtype)
                probs = self.drop(probs)
                out = torch.matmul(probs, v)
                out = out.transpose(1, 2).contiguous().view(b, t, -1)
                return self.o_proj(out)

        return _MHA()


class FeedForward:
    def __new__(cls, d_model: int, ffn_mult: int, dropout: float = 0.0):
        _, nn, F = _torch()
        hidden = d_model * ffn_mult

        class _FFN(nn.Module):
            def __init__(self):
                super().__init__()
                self.up = nn.Linear(d_model, hidden, bias=False)
                self.down = nn.Linear(hidden, d_model, bias=False)
                self.drop = nn.Dropout(dropout)

            def forward(self, x):
                return self.down(self.drop(F.gelu(self.up(x))))

        return _FFN()
