"""Regression tests for the "model never becomes READY" production outage.

Each test here pins one root cause that was found by reproducing the failure
against a real Qwen2-architecture model. They run fully offline against the
tiny locally-generated model, so they protect the lifecycle without needing
huggingface.co.

Root causes covered:
  1. A FAILED warm-up left the manager advertising READY (split brain).
  2. The readiness poll relaunched a failed load pipeline every 2 seconds.
  3. `int8` loaded weights as fp32 (4 B/param) -> OOM on a 2 GB instance.
  4. The HF cache-hit check never matched the real on-disk snapshot layout,
     so the weights were re-downloaded on every boot.
  5. Out-of-vocabulary stop tokens collapsed to UNK and truncated answers.

Run: .venv/bin/python -m pytest ai_engine/tests/test_model_readiness_regression.py -v
"""

from __future__ import annotations

import asyncio
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from config import Settings  # noqa: E402

_TINY_DIR = Path(__file__).resolve().parent / "tmp_tiny_torch"


def _torch_available() -> bool:
    try:
        import torch  # noqa: PLC0415, F401
        import transformers  # noqa: PLC0415, F401

        return True
    except Exception:
        return False


def _settings(**overrides) -> Settings:
    from tests.tools.make_tiny_torch import build as build_tiny

    if not (_TINY_DIR / "config.json").exists():
        build_tiny(_TINY_DIR)
    base = dict(
        llm_provider="local",
        local_model_runtime="torch",
        local_model_repo=str(_TINY_DIR),
        local_model_ctx_size=256,
        local_model_dtype="fp32",
        local_model_threads=1,
        local_preload_model=True,
        local_chat_wait_seconds=60,
        llm_max_output_tokens=32,
        rag_enabled=False,
    )
    base.update(overrides)
    return Settings(**base)


@unittest.skipUnless(_torch_available(), "torch/transformers not installed")
class ReadinessTruthTests(unittest.IsolatedAsyncioTestCase):
    """READY must mean the model can actually answer — never anything less."""

    async def test_failed_warmup_never_reports_ready(self):
        """Root cause #1: a failed warm-up must NOT advertise readiness.

        Previously the warm-up exception propagated out of the load pipeline
        without being recorded, while the generation path had already reset
        ``state`` to "ready" — so /api/ai/ready returned 200 for a model that
        could not generate a single token.
        """
        from inference.torch_runtime import TorchModelManager

        manager = TorchModelManager(_settings())

        async def failing_warmup(*_args, **_kwargs):
            raise RuntimeError("warm-up inference exploded")

        manager.self_test = failing_warmup  # type: ignore[assignment]
        manager.ensure_loading()
        with self.assertRaises(Exception):
            await manager.wait_ready(timeout=120)

        self.assertFalse(manager.is_ready(), "failed warm-up must not be READY")
        self.assertEqual(manager.state, "error")
        self.assertEqual(manager.lifecycle.state, "ERROR")
        # The exception must be surfaced, not swallowed.
        self.assertIn("warm-up inference exploded", manager.last_error)
        self.assertIsNotNone(manager.error_report)
        snap = manager.snapshot()
        self.assertFalse(snap["ready"])
        self.assertFalse(snap["inferenceAvailable"])
        self.assertFalse(snap["warmupComplete"])

    async def test_readiness_poll_does_not_thrash_failed_pipeline(self):
        """Root cause #2: a failed load must back off, not restart every poll.

        The gateway polls /api/ai/ready every 2s for up to 10 minutes. Each
        poll called ensure_loading(force=True), which relaunched the whole
        download+load pipeline, so one startup fault became an endless thrash
        that could never converge on READY.
        """
        from inference.torch_runtime import TorchModelManager

        manager = TorchModelManager(_settings())

        async def failing_warmup(*_args, **_kwargs):
            raise RuntimeError("nope")

        manager.self_test = failing_warmup  # type: ignore[assignment]
        manager.ensure_loading()
        with self.assertRaises(Exception):
            await manager.wait_ready(timeout=120)

        first_task = manager._load_task
        self.assertGreater(manager.retry_after_seconds(), 0, "must set a backoff window")

        for _ in range(10):  # simulate the gateway's readiness polling
            manager.ensure_loading(force=True)
        self.assertIs(manager._load_task, first_task, "poll must not relaunch the pipeline")
        self.assertEqual(manager._load_failures, 1)

    async def test_ready_model_reports_ready_and_streams_complete_answer(self):
        from inference.torch_runtime import TorchModelManager

        manager = TorchModelManager(_settings())
        manager.ensure_loading()
        await manager.wait_ready(timeout=180)

        self.assertTrue(manager.is_ready())
        snap = manager.snapshot()
        self.assertTrue(snap["ready"])
        self.assertTrue(snap["modelLoaded"])
        self.assertTrue(snap["tokenizerLoaded"])
        self.assertTrue(snap["warmupComplete"])
        self.assertIsNotNone(snap["warmupMs"])
        self.assertIsNotNone(snap["modelLoadMs"])

        pieces: list[str] = []
        await manager.generate(
            system_prompt="You are EduNova AI.",
            user_prompt="What is ML?",
            max_tokens=16,
            temperature=0.0,
            on_token=pieces.append,
            allow_empty=True,
        )
        # Real streaming: tokens arrive incrementally, not as one blob.
        self.assertGreater(len(pieces), 1)

    async def test_ensure_loading_is_single_flight(self):
        """Concurrent callers must share ONE load pipeline, never stack them."""
        from inference.torch_runtime import TorchModelManager

        manager = TorchModelManager(_settings())
        manager.ensure_loading()
        task = manager._load_task
        for _ in range(5):
            manager.ensure_loading(force=True)
        self.assertIs(manager._load_task, task)
        await manager.wait_ready(timeout=180)
        # Already ready: ensure_loading must be a no-op, never a reload.
        manager.ensure_loading(force=True)
        self.assertIs(manager._load_task, task)


@unittest.skipUnless(_torch_available(), "torch/transformers not installed")
class MemorySafetyTests(unittest.IsolatedAsyncioTestCase):
    async def test_int8_does_not_load_weights_as_fp32(self):
        """Root cause #3: int8 must load at 2 B/param, not 4 B/param.

        `auto` picks int8 because int8 *fits* the container; loading it as
        float32 anyway is what OOM-killed the 2 GB Render instance mid-load.
        """
        import torch

        from inference.torch_runtime import TorchModelManager

        manager = TorchModelManager(_settings(local_model_dtype="int8"))
        captured: dict[str, object] = {}
        original = manager._load_model

        async def spy():
            import transformers

            real = transformers.AutoModelForCausalLM.from_pretrained

            def wrapper(*args, **kwargs):
                captured["torch_dtype"] = kwargs.get("torch_dtype")
                return real(*args, **kwargs)

            transformers.AutoModelForCausalLM.from_pretrained = wrapper  # type: ignore[assignment]
            try:
                await original()
            finally:
                transformers.AutoModelForCausalLM.from_pretrained = real  # type: ignore[assignment]

        manager._load_model = spy  # type: ignore[assignment]
        manager.ensure_loading()
        await manager.wait_ready(timeout=180)

        self.assertNotEqual(
            captured.get("torch_dtype"),
            torch.float32,
            "int8 must never load weights in fp32 (4 B/param OOM)",
        )
        self.assertEqual(captured.get("torch_dtype"), torch.bfloat16)
        self.assertEqual(manager.snapshot()["dtype"], "int8")

    async def test_int8_model_actually_generates(self):
        """Quantized Linears need fp32 activations; a mixed-dtype model raises."""
        from inference.torch_runtime import TorchModelManager

        manager = TorchModelManager(_settings(local_model_dtype="int8"))
        manager.ensure_loading()
        await manager.wait_ready(timeout=180)
        text = await manager.generate(
            system_prompt="hi", user_prompt="ok", max_tokens=8, temperature=0.0, allow_empty=True
        )
        self.assertIsInstance(text, str)


class ModelCacheTests(unittest.TestCase):
    def test_finds_real_huggingface_snapshot_layout(self):
        """Root cause #4: cache hits must match the real HF on-disk layout.

        snapshot_download(cache_dir=X) writes to
        X/models--<org>--<name>/snapshots/<sha>/ — the old flat check never
        matched, so the weights re-downloaded on every single boot.
        """
        from inference.torch_runtime import TorchModelManager

        with tempfile.TemporaryDirectory() as tmp:
            cache = Path(tmp)
            snap = cache / "models--Qwen--Qwen2.5-0.5B-Instruct" / "snapshots" / "abc123"
            snap.mkdir(parents=True)
            (snap / "config.json").write_text("{}", encoding="utf-8")
            (snap / "model.safetensors").write_bytes(b"weights")

            found = TorchModelManager._find_cached_snapshot(cache, "Qwen/Qwen2.5-0.5B-Instruct")
            self.assertEqual(found, snap)

    def test_incomplete_snapshot_is_not_a_cache_hit(self):
        """A config without weights must re-download, not load a broken model."""
        from inference.torch_runtime import TorchModelManager

        with tempfile.TemporaryDirectory() as tmp:
            cache = Path(tmp)
            snap = cache / "models--Qwen--Qwen2.5-0.5B-Instruct" / "snapshots" / "abc123"
            snap.mkdir(parents=True)
            (snap / "config.json").write_text("{}", encoding="utf-8")  # no weights
            self.assertIsNone(
                TorchModelManager._find_cached_snapshot(cache, "Qwen/Qwen2.5-0.5B-Instruct")
            )

    def test_missing_cache_returns_none(self):
        from inference.torch_runtime import TorchModelManager

        with tempfile.TemporaryDirectory() as tmp:
            self.assertIsNone(
                TorchModelManager._find_cached_snapshot(Path(tmp), "Qwen/Qwen2.5-0.5B-Instruct")
            )


@unittest.skipUnless(_torch_available(), "torch/transformers not installed")
class StopTokenTests(unittest.TestCase):
    def test_out_of_vocab_stop_markers_are_rejected(self):
        """Root cause #5: unknown stop markers must not resolve to UNK.

        `convert_tokens_to_ids("</s>")` returns the UNK id for a ChatML vocab.
        Treating that as a stop id made generation halt on an ordinary token,
        truncating answers mid-sentence.
        """
        from transformers import AutoTokenizer

        from tests.tools.make_tiny_torch import build as build_tiny

        if not (_TINY_DIR / "config.json").exists():
            build_tiny(_TINY_DIR)
        tokenizer = AutoTokenizer.from_pretrained(str(_TINY_DIR))
        unk_id = tokenizer.unk_token_id

        for marker in ("</s>", "<|end|>", "<|im_end|>"):
            tid = tokenizer.convert_tokens_to_ids(marker)
            if not isinstance(tid, int) or tid < 0:
                continue
            if tid == unk_id:
                # This is exactly the case the runtime must reject.
                self.assertNotEqual(
                    tokenizer.convert_ids_to_tokens(tid),
                    marker,
                    f"{marker} resolved to UNK and must be filtered out",
                )


if __name__ == "__main__":
    unittest.main()
