"""Tests for the PyTorch-first inference runtime + lifecycle + RAG retrieval.

The runtime is exercised against a tiny locally-generated PyTorch model
(``tests/tools/make_tiny_torch.py``) so these tests run fully offline — they
verify the *pipeline* (load -> warm -> ready -> streamed generation, metrics,
quantization) without needing huggingface.co.

Run: .venv/bin/python -m pytest ai_engine/tests/test_torch_runtime.py -v
"""

from __future__ import annotations

import asyncio
import os
import sys
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from config import Settings, load_settings  # noqa: E402

_TINY_DIR = Path(__file__).resolve().parent / "tmp_tiny_torch"


def _tiny_settings(**overrides) -> Settings:
    from tests.tools.make_tiny_torch import build as build_tiny

    if not (_TINY_DIR / "model.safetensors").exists():
        build_tiny(_TINY_DIR)
    base = dict(
        llm_provider="local",
        local_model_runtime="torch",
        local_model_repo=str(_TINY_DIR),
        local_model_file="",
        local_model_ctx_size=256,
        local_model_dtype="fp32",
        local_model_threads=1,
        local_preload_model=True,
        local_chat_wait_seconds=60,
        llm_max_output_tokens=64,
        rag_enabled=False,
    )
    base.update(overrides)
    return Settings(**base)


@unittest.skipUnless(
    (lambda: True)(),
    "runtime tests need a torch-capable environment",
)
class TorchRuntimeTests(unittest.IsolatedAsyncioTestCase):
    def _skip_unless_torch(self) -> bool:
        try:
            import torch  # noqa: PLC0415

            return True
        except Exception:
            return False

    async def test_lifecycle_reaches_ready_and_generates(self):
        if not self._skip_unless_torch():
            self.skipTest("torch not importable")
        from inference.torch_runtime import TorchChatLLM, TorchModelManager

        manager = TorchModelManager(_tiny_settings())
        llm = TorchChatLLM(_tiny_settings(), manager)
        manager.ensure_loading()
        await manager.wait_ready(timeout=120)
        self.assertEqual(manager.state, "ready")
        self.assertEqual(manager.lifecycle.state, "READY")
        snap = manager.snapshot()
        self.assertTrue(snap["inferenceAvailable"])
        self.assertEqual(snap["runtimeName"], "torch")
        pieces: list[str] = []
        text = await llm.complete_text(
            system_prompt="Answer briefly.",
            user_prompt="what is ml",
            max_output_tokens=16,
            temperature=0.0,
            on_token=lambda piece: pieces.append(piece),
        )
        self.assertIsInstance(text, str)
        self.assertGreater(len(text), 0)
        self.assertGreater(len(pieces), 0)
        self.assertIsNotNone(manager.last_generation_metrics)
        self.assertIn("tokensPerSecond", manager.last_generation_metrics)

    async def test_int8_dynamic_quantization_runs(self):
        if not self._skip_unless_torch():
            self.skipTest("torch not importable")
        from inference.torch_runtime import TorchModelManager

        manager = TorchModelManager(_tiny_settings(local_model_dtype="int8"))
        manager.ensure_loading()
        await manager.wait_ready(timeout=120)
        self.assertEqual(manager.state, "ready")
        self.assertEqual(manager.snapshot().get("dtype"), "int8")
        text = await manager.generate(system_prompt="hi", user_prompt="ok", max_tokens=8, temperature=0.0)
        self.assertIsInstance(text, str)

    async def test_wait_ready_before_loading_queues_until_ready(self):
        """A request arriving while the model is not ready must queue, not 503."""
        if not self._skip_unless_torch():
            self.skipTest("torch not importable")
        from inference.torch_runtime import TorchModelManager

        settings = _tiny_settings()  # preload True; load not yet started
        manager = TorchModelManager(settings)
        # A chat request arrives before the model is ready: wait_ready must kick
        # off the load pipeline automatically and only return once READY.
        await manager.wait_ready(timeout=120)
        self.assertEqual(manager.state, "ready")
        self.assertEqual(manager.lifecycle.state, "READY")


@unittest.skipUnless(
    (lambda: True)(),
    "rag tests do not need a model",
)
class RagIndexTests(unittest.TestCase):
    def _index(self, tmp: Path):
        from inference.rag import Embedder, RagIndex

        # Force the deterministic lexical embedder (no downloads in tests).
        embedder = Embedder("lexical")
        return RagIndex(embedder=embedder, persist_dir=str(tmp))

    def test_chunking_and_search_isolation_between_owners(self):
        from inference.rag import chunk_text, RagIndex

        with tempfile.TemporaryDirectory() as tmp:
            index = self._index(Path(tmp))
            chunks = chunk_text(
                "Machine learning is a branch of artificial intelligence. "
                "It lets systems learn from data. A neural network is a "
                "common machine-learning model used for classification. "
                "Supervised learning uses labeled examples while unsupervised "
                "learning finds structure in unlabeled data. " * 12
            )
            self.assertGreater(len(chunks), 1)
            index.ingest_document("user-a", "ML notes", "\n\n".join(chunks))
            index.ingest_document("user-b", "Unrelated", "Cooking rice recipes for lunch boxes.")
            results_a = index.search("user-a", "machine learning neural network", k=3)
            results_b = index.search("user-b", "machine learning", k=3)
            self.assertGreater(len(results_a), 0)
            # Owner B must never see Owner A's chunks.
            for result in results_b:
                self.assertNotIn("neural network", result["text"])
            self.assertGreater(index.count("user-a"), 0)
            self.assertEqual(index.count("missing-user"), 0)

    def test_lifecycle_state_machine(self):
        from inference.lifecycle import ModelLifecycle

        lifecycle = ModelLifecycle()
        lifecycle.transition("LOADING")
        lifecycle.transition("WARMING")
        lifecycle.transition("READY")
        lifecycle.transition("BUSY")
        lifecycle.transition("READY")
        self.assertEqual(lifecycle.state, "READY")
        self.assertEqual(lifecycle.legacy, "ready")
        self.assertGreaterEqual(len(lifecycle.history), 4)


if __name__ == "__main__":
    unittest.main()
