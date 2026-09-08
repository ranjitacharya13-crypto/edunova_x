"""In-process PyTorch runtime for EduNovaHRM.

Implements the same generate() contract as LocalModelManager so the
inference supervisor can swap runtimes without changing the orchestrator.
"""

from __future__ import annotations

import asyncio
import json
import logging
import threading
import time
from pathlib import Path
from typing import Any

from agent.llm import LLMResponseError

logger = logging.getLogger("edunova.hrm.runtime")


class HRMRuntime:
    def __init__(self, settings, config=None, tokenizer=None, model=None):
        self.settings = settings
        self._config = config
        self._tokenizer = tokenizer
        self._model = model
        self.last_generation_metrics: dict[str, Any] | None = None
        self._lock = threading.Lock()
        self.file_size_bytes = 0
        self.loaded = False

    @property
    def checkpoint_dir(self) -> Path:
        raw = getattr(self.settings, "hrm_checkpoint", "") or ""
        if raw:
            path = Path(raw)
        else:
            path = Path(self.settings.local_model_dir) / "hrm"
        if not path.is_absolute():
            path = Path(__file__).resolve().parents[2] / path
        return path

    @property
    def config_path(self) -> Path | None:
        raw = getattr(self.settings, "hrm_config_path", "") or ""
        if not raw:
            return None
        path = Path(raw)
        if not path.is_absolute():
            path = Path(__file__).resolve().parents[3] / path
        return path

    def load(self) -> None:
        from hrm.config import load_hrm_config
        from hrm.hrm import EduNovaHRM
        from hrm.tokenizer import EduNovaTokenizer

        size = getattr(self.settings, "hrm_size", "") or "20m"
        cfg = load_hrm_config(self.config_path, size=size)
        self._config = cfg
        tok_dir = self.checkpoint_dir
        if (tok_dir / "tokenizer.json").exists():
            self._tokenizer = EduNovaTokenizer.load(tok_dir)
        else:
            self._tokenizer = EduNovaTokenizer()
            # Align vocab with config if the untrained tokenizer is smaller.
            if self._tokenizer.vocab_size < cfg.vocab_size:
                # Keep actual tokenizer size; config.vocab_size must match embeddings.
                cfg.vocab_size = self._tokenizer.vocab_size
        weights = self.checkpoint_dir / "pytorch_model.pt"
        if weights.exists():
            self._model = EduNovaHRM.from_pretrained(self.checkpoint_dir)
            self.file_size_bytes = weights.stat().st_size
            logger.info("HRM_CHECKPOINT_LOADED path=%s bytes=%s params=%s", weights, self.file_size_bytes, self._model.parameter_count())
        else:
            allow = bool(getattr(self.settings, "hrm_allow_untrained", False))
            if not allow:
                raise LLMResponseError(
                    "HRM checkpoint is missing. Train with `python training/train.py --config configs/model/20m.yaml` "
                    "or set HRM_ALLOW_UNTRAINED=true for development.",
                    status_code=503,
                    error_type="MODEL_NOT_FOUND",
                )
            self._model = EduNovaHRM(cfg)
            self._model.eval()
            self.file_size_bytes = self._model.disk_bytes_fp32()
            logger.warning("HRM_UNTRAINED_WEIGHTS params=%s — development only", self._model.parameter_count())
        self.loaded = True

    def plan_text(self, text: str) -> dict[str, Any]:
        if self._model is None or self._tokenizer is None:
            raise LLMResponseError("HRM is not loaded", status_code=503, error_type="MODEL_NOT_READY")
        import torch

        ids = self._tokenizer.encode(text, add_special=True)[: self._config.max_seq_len]
        padded, mask = self._tokenizer.pad([ids], self._config.max_seq_len)
        input_ids = torch.tensor(padded, dtype=torch.long)
        attention = torch.tensor(mask, dtype=torch.long)
        return self._model.plan(input_ids, attention)

    def generate_text(
        self,
        *,
        system_prompt: str,
        user_prompt: str,
        untrusted: str = "",
        max_tokens: int = 128,
        temperature: float | None = None,
        on_token=None,
        json_schema: dict[str, Any] | None = None,
    ) -> str:
        if self._model is None or self._tokenizer is None:
            raise LLMResponseError("HRM is not loaded", status_code=503, error_type="MODEL_NOT_READY")
        import torch

        temp = self.settings.llm_temperature if temperature is None else temperature
        ids = self._tokenizer.encode_chat(system_prompt, user_prompt, untrusted=untrusted)
        ids = ids[: self._config.max_seq_len]
        input_ids = torch.tensor([ids], dtype=torch.long)
        started = time.monotonic()
        first_ms = None
        pieces: list[str] = []

        def _cb(token_id: int) -> None:
            nonlocal first_ms
            if first_ms is None:
                first_ms = int((time.monotonic() - started) * 1000)
            piece = self._tokenizer.decode([token_id], skip_special=True)
            if piece:
                pieces.append(piece)
                if on_token is not None:
                    on_token(piece)

        # SFT (edunova-tok-v2) checkpoints are teacher-forced with the
        # decoder starting at <assistant>; legacy v1 checkpoints used <bos>.
        start_id = self._tokenizer.bos_id
        if str(getattr(self._tokenizer, "version", "")).startswith("edunova-tok-v"):
            major = str(getattr(self._tokenizer, "version", "")).rsplit("-v", 1)[-1]
            if major.isdigit() and int(major) >= 2:
                start_id = self._tokenizer.token_to_id.get("<assistant>", start_id)
        with self._lock:
            out_ids = self._model.generate(
                input_ids,
                max_new_tokens=max(8, min(int(max_tokens), self.settings.llm_max_output_tokens)),
                temperature=temp,
                eos_id=self._tokenizer.eos_id,
                on_token=_cb,
                start_token_id=start_id,
            )
        text = self._tokenizer.decode(out_ids[0].tolist(), skip_special=True).strip()
        if json_schema and text:
            # Best-effort: if JSON was requested but the model emitted prose, wrap as answer.
            try:
                json.loads(text)
            except json.JSONDecodeError:
                text = json.dumps({"action": "final", "answer": text, "type": "FINAL_ANSWER"}, ensure_ascii=False)
        duration = max(0.001, time.monotonic() - started)
        tokens = int(out_ids.size(1))
        self.last_generation_metrics = {
            "tokens": tokens,
            "finishReason": "stop",
            "durationMs": int(duration * 1000),
            "tokensPerSecond": round(tokens / duration, 2),
            "firstTokenMs": first_ms,
            "responseChars": len(text),
            "runtime": "hrm",
        }
        if not text:
            raise LLMResponseError("The EduNova HRM returned an empty response", status_code=502, error_type="invalid_response")
        return text

    async def generate(
        self,
        *,
        system_prompt: str,
        user_prompt: str,
        max_tokens: int,
        temperature: float | None = None,
        json_schema: dict[str, Any] | None = None,
        allow_empty: bool = False,
        on_token: Any = None,
    ) -> str:
        if not self.loaded:
            raise LLMResponseError("HRM weights are not loaded", status_code=503, error_type="MODEL_NOT_READY")
        return await asyncio.to_thread(
            self.generate_text,
            system_prompt=system_prompt,
            user_prompt=user_prompt,
            max_tokens=max_tokens,
            temperature=temperature,
            on_token=on_token,
            json_schema=json_schema,
        )

    def snapshot(self) -> dict[str, Any]:
        params = self._model.parameter_count() if self._model is not None else None
        return {
            "runtime": "hrm",
            "modelId": getattr(self._config, "name", "edunova-hrm"),
            "architectureVersion": getattr(self._config, "architecture_version", "hrm-v1"),
            "tokenizerVersion": getattr(self._tokenizer, "version", None),
            "parameterCount": params,
            "fileSizeBytes": self.file_size_bytes,
            "modelLoaded": self.loaded,
            "tokenizerLoaded": self._tokenizer is not None,
            "contextSize": getattr(self._config, "max_seq_len", None),
            "lastGeneration": self.last_generation_metrics,
        }
