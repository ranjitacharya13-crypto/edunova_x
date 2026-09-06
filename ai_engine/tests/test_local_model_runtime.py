"""REAL end-to-end tests of the self-hosted model pipeline.

Unlike ``test_local_model.py`` (which uses a fake ``llama_cpp`` module), this
suite uses:

* a **real llama.cpp runtime** (``llama-cpp-python``), and
* a **real GGUF file** (structurally valid, random weights — see
  ``tools/make_tiny_gguf.py``), served over a **real HTTP server**.

That makes it the regression test for the incident this module exists for:
a ``LOCAL_MODEL_FILE`` that does not exist on the model host used to fail with
an opaque "model download failed with HTTP 404". The tests below assert the
404 is now caught by the startup preflight and reported as a structured
``MODEL_STARTUP_ERROR`` naming the model, the URL and the status.

Skipped automatically when ``llama_cpp`` / ``gguf`` are unavailable, so it
never breaks a lightweight environment:

    python -m unittest ai_engine.tests.test_local_model_runtime -v
"""

from __future__ import annotations

import asyncio
import http.server
import socket
import sys
import tempfile
import threading
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from agent.llm import LLMResponseError  # noqa: E402
from agent.local_llm import (  # noqa: E402
    LocalModelManager,
    ModelSourceError,
    runtime_available,
)
from config import Settings  # noqa: E402
from inference.manager import ModelManager  # noqa: E402

try:  # pragma: no cover - environment probe
    import gguf  # noqa: F401

    GGUF_WRITER_AVAILABLE = True
except Exception:  # pragma: no cover
    GGUF_WRITER_AVAILABLE = False

RUNTIME = runtime_available()
TINY_MODEL: Path | None = None
_MODEL_BYTES: bytes = b""


def setUpModule() -> None:  # noqa: N802 - unittest hook
    global TINY_MODEL, _MODEL_BYTES
    if not (RUNTIME and GGUF_WRITER_AVAILABLE):
        return
    sys.path.insert(0, str(Path(__file__).resolve().parent / "tools"))
    from make_tiny_gguf import build  # noqa: PLC0415

    target = Path(tempfile.mkdtemp(prefix="edunova-gguf-")) / "edunova-tiny-test.gguf"
    build(str(target))
    TINY_MODEL = target
    _MODEL_BYTES = target.read_bytes()


class _ModelHTTPHandler(http.server.BaseHTTPRequestHandler):
    """Serves the tiny model at /model.gguf, 404s everything else."""

    protocol_version = "HTTP/1.1"
    flaky_failures = 0  # /flaky.gguf fails this many times, then succeeds

    def log_message(self, *args):  # noqa: A003 - silence test output
        return

    def _serve(self, body: bytes, status: int = 200, head_only: bool = False):
        self.send_response(status)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Accept-Ranges", "bytes")
        self.end_headers()
        if not head_only and body:
            self.wfile.write(body)

    def _route(self, head_only: bool) -> None:
        path = self.path.split("?", 1)[0]
        if path == "/model.gguf":
            self._serve(_MODEL_BYTES, head_only=head_only)
        elif path == "/flaky.gguf":
            if type(self).flaky_failures > 0 and not head_only:
                type(self).flaky_failures -= 1
                self.send_response(503)
                self.send_header("Content-Length", "0")
                self.end_headers()
            else:
                self._serve(_MODEL_BYTES, head_only=head_only)
        elif path == "/not-a-model.gguf":
            self._serve(b"<html>error page</html>", head_only=head_only)
        else:
            body = b"Entry not found"
            self.send_response(404)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            if not head_only:
                self.wfile.write(body)

    def do_GET(self):  # noqa: N802
        self._route(head_only=False)

    def do_HEAD(self):  # noqa: N802
        self._route(head_only=True)


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


@unittest.skipUnless(RUNTIME and GGUF_WRITER_AVAILABLE, "llama-cpp-python / gguf not installed")
class LocalModelRuntimeTests(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls):
        cls.port = _free_port()
        cls.server = http.server.ThreadingHTTPServer(("127.0.0.1", cls.port), _ModelHTTPHandler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = f"http://127.0.0.1:{cls.port}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    async def _start(self, manager: ModelManager, timeout: float = 120) -> None:
        manager.ensure_loading()
        await asyncio.wait_for(manager._ready_event.wait(), timeout)

    def _settings(self, tmp: str, filename: str = "model.gguf", **overrides) -> Settings:
        base = dict(
            llm_provider="local",
            local_model_url=f"{self.base}/{filename}",
            local_model_dir=tmp,
            local_model_min_bytes=4096,
            local_model_ctx_size=512,
            local_model_batch=64,
            local_model_threads=2,
            local_chat_wait_seconds=90,
            local_model_download_timeout=90,
            local_model_download_retries=3,
            llm_max_output_tokens=32,
        )
        base.update(overrides)
        return Settings(**base)

    # -- the incident ------------------------------------------------------
    async def test_missing_model_file_reports_structured_404(self):
        """A wrong LOCAL_MODEL_FILE must fail with a named URL + status 404."""
        with tempfile.TemporaryDirectory() as tmp:
            settings = self._settings(tmp, filename="does-not-exist.gguf")
            manager = LocalModelManager(settings)
            with self.assertRaises(ModelSourceError) as ctx:
                await manager.preflight()
            error = ctx.exception
            self.assertEqual(error.status, 404)
            self.assertTrue(error.permanent, "404 must not be retried")
            self.assertIn("not found", error.reason)
            rendered = error.render()
            self.assertIn("MODEL_STARTUP_ERROR", rendered)
            self.assertIn("Status: 404", rendered)
            self.assertIn("does-not-exist.gguf", rendered)

            # ...and the supervisor surfaces it as an honest 503, never a fake answer.
            supervisor = ModelManager(settings)
            try:
                supervisor.ensure_loading()
                await asyncio.wait_for(supervisor._ready_event.wait(), 30)
                with self.assertRaises(LLMResponseError) as chat_ctx:
                    await supervisor.wait_ready()
                # A proven 404 for a custom URL is terminal MODEL_NOT_FOUND
                # (self-heal only applies to catalogue repos). A transport
                # failure of the same fetch would be MODEL_DOWNLOAD_FAILED;
                # what must NEVER happen is a non-terminal "warming" lie.
                self.assertIn(chat_ctx.exception.error_type, {"MODEL_NOT_FOUND", "MODEL_DOWNLOAD_FAILED"})
                self.assertEqual(supervisor.public_state, "MODEL_FAILED")
                self.assertTrue(supervisor.error_report["permanent"])
                self.assertIn("404", supervisor.last_error)
            finally:
                await supervisor.close()

    async def test_credentials_are_never_exposed_in_diagnostics(self):
        with tempfile.TemporaryDirectory() as tmp:
            settings = self._settings(tmp).__class__(
                llm_provider="local",
                local_model_url="https://user:s3cret@mirror.example.com/m.gguf?token=abc",
                local_model_dir=tmp,
            )
            manager = LocalModelManager(settings)
            self.assertNotIn("s3cret", manager.safe_url)
            self.assertNotIn("abc", manager.safe_url)
            self.assertIn("<redacted>", manager.safe_url)

    # -- the happy path ----------------------------------------------------
    async def test_download_verify_load_and_generate(self):
        import hashlib

        digest = hashlib.sha256(_MODEL_BYTES).hexdigest()
        with tempfile.TemporaryDirectory() as tmp:
            settings = self._settings(
                tmp,
                local_model_sha256=digest,
                local_model_expected_bytes=len(_MODEL_BYTES),
            )
            manager = ModelManager(settings)
            try:
                await self._start(manager)
                self.assertEqual(manager.public_state, "MODEL_READY")
                snap = manager.snapshot(include_source=True)
                self.assertTrue(snap["ready"])
                self.assertTrue(snap["modelLoaded"])
                self.assertTrue(snap["warmupComplete"])
                self.assertTrue(snap["inferenceTest"], "READY requires a real inference test")
                self.assertTrue(snap["inferenceAvailable"])
                self.assertEqual(snap["fileSizeBytes"], len(_MODEL_BYTES))
                self.assertIsNotNone(snap["memoryRequirement"])

                # Real tokens out of real llama.cpp, streamed token by token.
                # A random-weights toy model never emits EOS, so the honest
                # completion guard (OUTPUT_LIMIT_REACHED) may fire AFTER real
                # decoding; either path is genuine generation. What must never
                # happen is silence, a canned string, or a fake 200.
                pieces: list[str] = []
                text = ""
                try:
                    text = await manager.generate(
                        system_prompt="You are EduNova AI.",
                        user_prompt="what is ml",
                        max_tokens=16,
                        on_token=pieces.append,
                    )
                except LLMResponseError as exc:
                    if exc.error_type != "OUTPUT_LIMIT_REACHED":
                        raise
                metrics = manager.last_generation_metrics or {}
                self.assertGreaterEqual(int(metrics.get("tokens") or 0), 1, "real decoded tokens")
                self.assertTrue(pieces, "streaming must deliver incremental tokens")
                if text:
                    self.assertTrue(text.strip(), "the local model must produce real output")

                try:
                    probe = await manager.self_test()
                    self.assertTrue(probe["ok"])
                except LLMResponseError as exc:
                    self.assertEqual(exc.error_type, "OUTPUT_LIMIT_REACHED",
                                     "only the honesty guard may stop the probe")
                    self.assertGreaterEqual(int((manager.last_generation_metrics or {}).get("tokens") or 0), 1)
            finally:
                await manager.close()

    async def test_cached_model_is_not_downloaded_again(self):
        with tempfile.TemporaryDirectory() as tmp:
            settings = self._settings(tmp)
            first = ModelManager(settings)
            try:
                await self._start(first)
                self.assertGreaterEqual(int(first.facts.get("downloadAttempts") or 0), 1)
            finally:
                await first.close()

            # A fresh manager (i.e. a service restart) over the same cache dir
            # must reuse the file: zero download attempts.
            second = ModelManager(settings)
            try:
                await self._start(second)
                self.assertEqual(int(second.facts.get("downloadAttempts") or 0), 0, "cached model was re-downloaded")
                self.assertEqual(second.public_state, "MODEL_READY")
            finally:
                await second.close()

    async def test_corrupt_cache_is_replaced_not_loaded(self):
        with tempfile.TemporaryDirectory() as tmp:
            settings = self._settings(tmp)
            path = LocalModelManager(settings).model_path
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"NOTGGUF" + b"\x00" * 100_000)

            manager = ModelManager(settings)
            try:
                await self._start(manager)
                self.assertEqual(manager.public_state, "MODEL_READY")
                self.assertEqual(path.read_bytes()[:4], b"GGUF")
            finally:
                await manager.close()

    async def test_transient_failures_are_retried(self):
        _ModelHTTPHandler.flaky_failures = 2
        try:
            with tempfile.TemporaryDirectory() as tmp:
                settings = self._settings(tmp, filename="flaky.gguf")
                manager = ModelManager(settings)
                try:
                    await self._start(manager, 180)
                    self.assertEqual(manager.public_state, "MODEL_READY")
                    self.assertGreater(int(manager.facts.get("downloadAttempts") or 0), 1, "503 should have been retried")
                finally:
                    await manager.close()
        finally:
            _ModelHTTPHandler.flaky_failures = 0

    async def test_error_page_is_rejected_as_not_a_model(self):
        with tempfile.TemporaryDirectory() as tmp:
            settings = self._settings(tmp, filename="not-a-model.gguf", local_model_min_bytes=4096)
            manager = ModelManager(settings)
            try:
                await self._start(manager, 60)
                with self.assertRaises(LLMResponseError):
                    await manager.wait_ready()
                self.assertEqual(manager.public_state, "MODEL_FAILED")
                self.assertIn(manager.phase, {"MODEL_DOWNLOAD_FAILED", "MODEL_INVALID"})
            finally:
                await manager.close()

    async def test_checksum_mismatch_is_fatal(self):
        with tempfile.TemporaryDirectory() as tmp:
            settings = self._settings(tmp, local_model_sha256="0" * 64)
            manager = ModelManager(settings)
            try:
                await self._start(manager)
                with self.assertRaises(LLMResponseError):
                    await manager.wait_ready()
                self.assertEqual(manager.public_state, "MODEL_FAILED")
                self.assertIn("checksum", manager.last_error.lower())
                self.assertFalse(LocalModelManager(settings).model_path.exists())
            finally:
                await manager.close()

    # -- planner integration ----------------------------------------------
    async def test_grammar_constrained_json_from_real_runtime(self):
        """The planner contract (valid JSON decision) must hold on real llama.cpp."""
        with tempfile.TemporaryDirectory() as tmp:
            settings = self._settings(tmp)
            from agent.llm import parse_json_object
            from agent.local_llm import DECISION_SCHEMA

            manager = ModelManager(settings)
            try:
                await self._start(manager)
                raw = await manager.generate(
                    system_prompt="Return a decision.",
                    user_prompt="what is ml",
                    max_tokens=64,
                    json_schema=DECISION_SCHEMA,
                )
                decision = parse_json_object(raw)
                # Random weights cannot produce a *sensible* plan, but the GBNF
                # grammar must still force a parseable, schema-shaped object.
                self.assertIsInstance(decision, dict)
                self.assertIn("action", decision)
            finally:
                await manager.close()


if __name__ == "__main__":
    unittest.main()
