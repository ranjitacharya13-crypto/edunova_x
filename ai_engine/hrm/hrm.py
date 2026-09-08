"""EduNovaHRM: two-level hierarchical reasoner implemented in this project.

High-level encoder decides task/tool/output type.
Low-level decoder generates tokens conditioned on that plan.

This is not a renamed Hugging Face causal LM. Torch is imported lazily so
the orchestrator process never loads it.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from .config import HRMConfig, OUTPUT_TYPE_NAMES, TASK_TYPES, TOOL_NAMES

_MODEL_CLS = None


def _model_class():
    global _MODEL_CLS
    if _MODEL_CLS is not None:
        return _MODEL_CLS

    import torch
    import torch.nn as nn

    from .high_level_reasoner import HighLevelReasoner
    from .low_level_reasoner import LowLevelReasoner

    class _EduNovaHRM(nn.Module):
        def __init__(self, config: HRMConfig | None = None):
            super().__init__()
            config = config or HRMConfig()
            self.config = config
            self.tok_emb = nn.Embedding(config.vocab_size, config.d_model, padding_idx=config.pad_id)
            nn.init.normal_(self.tok_emb.weight, mean=0.0, std=0.02)
            with torch.no_grad():
                self.tok_emb.weight[config.pad_id].zero_()
            self.high = HighLevelReasoner(config)
            self.low = LowLevelReasoner(config)
            self.task_types = TASK_TYPES
            self.tool_names = TOOL_NAMES
            self.output_types = OUTPUT_TYPE_NAMES

        def parameter_count(self) -> int:
            return sum(p.numel() for p in self.parameters())

        def trainable_parameter_count(self) -> int:
            return sum(p.numel() for p in self.parameters() if p.requires_grad)

        def disk_bytes_fp32(self) -> int:
            return self.parameter_count() * 4

        def forward(
            self,
            input_ids,
            attention_mask=None,
            decoder_input_ids=None,
            decoder_attention_mask=None,
        ):
            if attention_mask is None:
                padding = input_ids.ne(self.config.pad_id)
            else:
                padding = attention_mask.bool()
            enc = self.tok_emb(input_ids)
            high = self.high(enc, padding)
            if decoder_input_ids is None:
                decoder_input_ids = input_ids
            dec = self.tok_emb(decoder_input_ids)
            dec = dec.clone()
            dec[:, 0] = dec[:, 0] + high["summary"]
            low = self.low(
                dec,
                high["memory"],
                memory_padding=padding,
                embedding_weight=self.tok_emb.weight if self.config.tie_embeddings else None,
            )
            return {**high, **low}

        def plan(self, input_ids, attention_mask=None) -> dict[str, Any]:
            self.eval()
            with torch.no_grad():
                if attention_mask is None:
                    padding = input_ids.ne(self.config.pad_id)
                else:
                    padding = attention_mask.bool()
                high = self.high(self.tok_emb(input_ids), padding)
            task_id = int(high["task_logits"][0].argmax().item())
            tool_id = int(high["tool_logits"][0].argmax().item())
            out_id = int(high["output_type_logits"][0].argmax().item())
            need_tools = int(high["need_tools_logits"][0].argmax().item()) == 1
            tool_probs = torch.softmax(high["tool_logits"][0].float(), dim=-1)
            topk = torch.topk(tool_probs, k=min(5, tool_probs.numel()))
            tools = []
            for score, idx in zip(topk.values.tolist(), topk.indices.tolist()):
                name = self.tool_names[idx]
                if name != "none" and score >= 0.08:
                    tools.append(name)
            if need_tools and not tools:
                name = self.tool_names[tool_id]
                if name != "none":
                    tools = [name]
            return {
                "task_type": self.task_types[task_id],
                "primary_tool": self.tool_names[tool_id],
                "tools": tools,
                "need_tools": need_tools,
                "output_type": self.output_types[out_id],
                "task_id": task_id,
                "tool_id": tool_id,
                "output_type_id": out_id,
            }

        @torch.no_grad()
        def generate(
            self,
            input_ids,
            max_new_tokens: int = 64,
            temperature: float = 0.2,
            eos_id: int | None = None,
            on_token=None,
        ):
            self.eval()
            eos_id = self.config.eos_id if eos_id is None else eos_id
            padding = input_ids.ne(self.config.pad_id)
            memory_pack = self.high(self.tok_emb(input_ids), padding)
            memory = memory_pack["memory"]
            b = input_ids.size(0)
            generated = torch.full((b, 1), self.config.bos_id, dtype=torch.long, device=input_ids.device)
            kv_caches = [{} for _ in range(self.config.low_level_layers)]
            for _ in range(max_new_tokens):
                tok = generated[:, -1:]
                hidden = self.tok_emb(tok)
                if generated.size(1) == 1:
                    hidden = hidden + memory_pack["summary"].unsqueeze(1)
                low = self.low(
                    hidden,
                    memory,
                    memory_padding=padding,
                    kv_caches=kv_caches,
                    embedding_weight=self.tok_emb.weight if self.config.tie_embeddings else None,
                )
                logits = low["logits"][:, -1]
                if temperature and temperature > 0:
                    logits = logits / max(1e-5, temperature)
                    probs = torch.softmax(logits.float(), dim=-1)
                    next_id = torch.multinomial(probs, num_samples=1)
                else:
                    next_id = logits.argmax(dim=-1, keepdim=True)
                token = int(next_id[0].item())
                if on_token is not None:
                    on_token(token)
                generated = torch.cat([generated, next_id], dim=1)
                if token == eos_id:
                    break
            return generated[:, 1:]

        def save_pretrained(self, directory: str | Path, tokenizer=None) -> Path:
            directory = Path(directory)
            directory.mkdir(parents=True, exist_ok=True)
            torch.save(
                {
                    "model_state": self.state_dict(),
                    "config": self.config.to_dict(),
                    "architecture_version": self.config.architecture_version,
                },
                directory / "pytorch_model.pt",
            )
            (directory / "config.json").write_text(
                __import__("json").dumps(self.config.to_dict(), indent=2), encoding="utf-8"
            )
            if tokenizer is not None:
                tokenizer.save(directory)
            return directory

        @classmethod
        def from_pretrained(cls, directory: str | Path, map_location: str = "cpu"):
            directory = Path(directory)
            try:
                payload = torch.load(directory / "pytorch_model.pt", map_location=map_location, weights_only=True)
            except TypeError:
                payload = torch.load(directory / "pytorch_model.pt", map_location=map_location)
            cfg = HRMConfig.from_dict(payload["config"])
            model = cls(cfg)
            model.load_state_dict(payload["model_state"])
            model.eval()
            return model

    _MODEL_CLS = _EduNovaHRM
    return _MODEL_CLS


def EduNovaHRM(config: HRMConfig | None = None):
    """Construct a new EduNovaHRM module (lazy torch import)."""
    return _model_class()(config)


def from_pretrained(directory: str | Path, map_location: str = "cpu"):
    return _model_class().from_pretrained(directory, map_location=map_location)


def build_model(config: HRMConfig | None = None) -> Any:
    return EduNovaHRM(config)


# Allow EduNovaHRM.from_pretrained even though EduNovaHRM is a factory function.
EduNovaHRM.from_pretrained = from_pretrained  # type: ignore[attr-defined]
