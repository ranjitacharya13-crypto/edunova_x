"""Real LoRA adapters: frozen base Linear layers + trainable A/B matrices."""

from __future__ import annotations

from typing import Iterable


def _torch():
    import torch
    import torch.nn as nn
    import torch.nn.functional as F

    return torch, nn, F


class LoRALinear:
    def __new__(cls, linear, rank: int = 8, alpha: int = 16):
        torch, nn, F = _torch()

        class _LoRA(nn.Module):
            def __init__(self):
                super().__init__()
                self.linear = linear
                for p in self.linear.parameters():
                    p.requires_grad = False
                in_f = linear.in_features
                out_f = linear.out_features
                self.rank = rank
                self.alpha = alpha
                self.A = nn.Parameter(torch.zeros(rank, in_f))
                self.B = nn.Parameter(torch.zeros(out_f, rank))
                nn.init.kaiming_uniform_(self.A, a=5 ** 0.5)
                nn.init.zeros_(self.B)
                self.scaling = alpha / rank

            def forward(self, x):
                base = self.linear(x)
                lora = F.linear(F.linear(x, self.A), self.B) * self.scaling
                return base + lora

        return _LoRA()


def inject_lora(model, *, rank: int = 8, alpha: int = 16, target_substrings: Iterable[str] = ("q_proj", "v_proj", "o_proj")) -> int:
    """Replace matching Linear modules with LoRALinear. Returns adapter count."""
    _, nn, _ = _torch()
    replaced = 0

    def _convert(module):
        nonlocal replaced
        for name, child in list(module.named_children()):
            if isinstance(child, nn.Linear) and any(key in name for key in target_substrings):
                setattr(module, name, LoRALinear(child, rank=rank, alpha=alpha))
                replaced += 1
            else:
                _convert(child)

    _convert(model)
    return replaced


def lora_state_dict(model) -> dict:
    return {k: v for k, v in model.state_dict().items() if ".A" in k or ".B" in k}


def load_lora_state(model, state: dict) -> None:
    missing = model.load_state_dict(state, strict=False)
    return missing
