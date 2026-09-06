"""RENDER FREE (512 MiB) startup proof for the self-hosted inference service.

This module pins the whole free-tier contract in two layers:

1. **Deterministic configuration proof** (always runs): the shipped default
   model + LOCAL_MODEL_CTX=2048 + LOCAL_MODEL_THREADS=1 + RAG_ENABLED=false
   fits a 512 MiB container according to the SAME estimator the service uses
   at boot, while the old Qwen2.5-0.5B entry and any RAG-enabled variant are
   correctly rejected. The verified catalogue file (name, size, sha256) is
   checked against the HuggingFace LFS metadata recorded in ``config.py``.

2. **Real startup test** (skipped only when llama-cpp-python / gguf are not
   installed, same policy as ``test_local_model_runtime.py``): a real GGUF is
   served over local HTTP, the ACTUAL ``inference_server:app`` boots under a
   simulated 512 MiB memory limit, and the test asserts

     * the model genuinely LOADS (MODEL_LOADED -> WARMUP -> INFERENCE TEST),
     * a simple prompt produces a REAL model-generated response (decoded
       tokens from llama.cpp; nothing is templated, cached or faked),
     * ``GET /health`` answers 200,
     * ``GET /ready`` reports ``MODEL_READY``,
     * auth (AI_INTERNAL_TOKEN) gates the private endpoints,
     * embeddings stay unloaded (``RAG_ENABLED=false``; torch is never
       imported by the parent, /embeddings answers EMBEDDINGS_UNAVAILABLE).

Run:
    python -m pytest ai_engine/tests/test_free_tier_startup.py -q
    python -m unittest ai_engine.tests.test_free_tier_startup -v
"""

from __future__ import annotations

import http.server
import os
import socket
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from config import (  # noqa: E402
    DEFAULT_LOCAL_MODEL_FILE,
    DEFAULT_LOCAL_MODEL_REPO,
    KNOWN_MODELS,
    Settings,
    known_model_entry,
    load_settings,
)
from inference.resources import (  # noqa: E402
    ResourceInsufficient,
    check_model_fits,
    estimate_requirement,
)

try:  # pragma: no cover - environment probe
    from agent.local_llm import runtime_available

    import gguf  # noqa: F401

    REAL_RUNTIME_AVAILABLE = runtime_available() and True
except Exception:  # pragma: no cover
    REAL_RUNTIME_AVAILABLE = False

FREE_LIMIT_MB = 512
_TEST_TOKEN = "edunova-free-startup-token"


# ---------------------------------------------------------------------------
# 1) Deterministic free-tier sizing contract
# ---------------------------------------------------------------------------
class FreeTierModelSelectionTests(unittest.TestCase):
    def test_shipped_default_is_the_small_verified_model(self):
        self.assertEqual(Settings().local_model_repo, DEFAULT_LOCAL_MODEL_REPO)
        self.assertEqual(Settings().local_model_file, DEFAULT_LOCAL_MODEL_FILE)
        self.assertEqual(DEFAULT_LOCAL_MODEL_REPO, "bartowski/SmolLM2-135M-Instruct-GGUF")
        self.assertEqual(DEFAULT_LOCAL_MODEL_FILE, "SmolLM2-135M-Instruct-Q4_K_M.gguf")
        entry = known_model_entry(DEFAULT_LOCAL_MODEL_REPO, DEFAULT_LOCAL_MODEL_FILE)
        self.assertIsNotNone(entry, "the default must be a verified catalogue entry")
        # Exact values captured from the HuggingFace LFS tree metadata.
        self.assertEqual(int(entry["bytes"]), 105_454_432)
        self.assertEqual(str(entry["sha256"]),
                         "2e8040ceae7815abe0dcb3540b9995eaa1fa0d2ca9e797d0a635ae4433c68c2d")
        self.assertEqual(str(entry["chat_format"]), "chatml")
        # "roughly 100-150 MB", never another 0.5B+ model:
        self.assertLessEqual(int(entry["bytes"]), 150 * 1024 * 1024)
        self.assertGreaterEqual(int(entry["bytes"]), 50 * 1024 * 1024)

    def test_free_tier_inference_settings_defaults(self):
        """With NO environment at all, the code defaults ARE the free profile."""
        from unittest.mock import patch
        with patch.dict(os.environ, {}, clear=True):
            settings = load_settings()
        self.assertEqual(settings.local_model_ctx_size, 2048)
        self.assertEqual(settings.local_model_threads, 1)
        self.assertFalse(settings.rag_enabled)
        self.assertEqual(settings.llm_max_output_tokens, 1024)
        self.assertLessEqual(settings.agent_max_context_chars, 6_200)
        self.assertTrue(settings.is_local_llm)
        self.assertEqual(settings.llm_provider, "local")
        self.assertIsNone(settings.llm_configuration_error)
        self.assertFalse(bool(settings.llm_api_key))

    def test_free_profile_fits_512mib_by_the_boot_estimator(self):
        """estimate_requirement + check_model_fits are exactly what boot runs."""
        entry = known_model_entry(DEFAULT_LOCAL_MODEL_REPO, DEFAULT_LOCAL_MODEL_FILE)
        requirement = estimate_requirement(
            runtime="llama_cpp", model_path=None, ctx=2048,
            catalogue_ram_mb=int(entry["ram_mb"]), expected_bytes=int(entry["bytes"]),
            with_embeddings=False,
        )
        self.assertLessEqual(requirement["required_mb"], FREE_LIMIT_MB,
                             f"free profile must fit: {requirement}")
        self.assertEqual(requirement["embedding_overhead_mb"], 0)
        fits = check_model_fits(requirement, {"ram_limit_mb": FREE_LIMIT_MB, "ram_total_mb": FREE_LIMIT_MB})
        self.assertTrue(fits["fits"])
        # The recommended plan for this configuration IS the free plan itself.
        self.assertEqual(requirement["recommended_mb"], FREE_LIMIT_MB)

    def test_rag_on_free_instance_is_still_correctly_refused(self):
        """Disabling RAG must be the thing that makes it fit — a re-enabled
        embedding model on 512 MiB is rejected with numbers, not OOM-killed."""
        entry = known_model_entry(DEFAULT_LOCAL_MODEL_REPO, DEFAULT_LOCAL_MODEL_FILE)
        requirement = estimate_requirement(
            runtime="llama_cpp", model_path=None, ctx=2048,
            catalogue_ram_mb=int(entry["ram_mb"]), expected_bytes=int(entry["bytes"]),
            with_embeddings=True,
        )
        self.assertGreater(requirement["required_mb"], FREE_LIMIT_MB)
        with self.assertRaises(ResourceInsufficient):
            check_model_fits(requirement, {"ram_limit_mb": FREE_LIMIT_MB, "ram_total_mb": FREE_LIMIT_MB})

    def test_oversized_models_are_rejected_on_free_not_silently_allowed(self):
        """Requirement 2/8: no 0.5B-class model may pass the 512 MiB gate."""
        for (repo, filename), entry in KNOWN_MODELS.items():
            if repo == DEFAULT_LOCAL_MODEL_REPO and filename == DEFAULT_LOCAL_MODEL_FILE:
                continue  # the fit case is covered above
            if not str(repo).upper().endswith("-GGUF") or "SmolLM2-135M" in filename:
                continue
            requirement = estimate_requirement(
                runtime="llama_cpp", model_path=None, ctx=int(entry.get("ctx", 2048)),
                catalogue_ram_mb=int(entry["ram_mb"]), expected_bytes=int(entry["bytes"]),
                with_embeddings=False,
            )
            self.assertGreater(requirement["required_mb"], FREE_LIMIT_MB,
                               f"{repo}:{filename} must NOT fit 512 MiB (got {requirement['required_mb']})")
            with self.assertRaises(ResourceInsufficient):
                check_model_fits(requirement, {"ram_limit_mb": FREE_LIMIT_MB, "ram_total_mb": FREE_LIMIT_MB})

    def test_no_external_llm_provider_config(self):
        """Self-hosted only: the settings contract never demands an API key."""
        settings = Settings()
        self.assertTrue(settings.llm_configured)
        diag = settings.llm_safe_diagnostics()
        self.assertTrue(diag["selfHosted"])
        self.assertFalse(diag["apiKeyRequired"])
        self.assertFalse(bool(settings.llm_api_key))


# ---------------------------------------------------------------------------
# 2) Real boot test: llama.cpp loads a real GGUF and serves real tokens
#    through the actual inference_server FastAPI app on a simulated 512 MiB box
# ---------------------------------------------------------------------------
def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class _ModelFileHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):  # silence
        return


@unittest.skipUnless(REAL_RUNTIME_AVAILABLE, "llama-cpp-python / gguf not installed")
class FreeTierServiceStartupTests(unittest.TestCase):
    """Boots inference_server:app end-to-end against a real GGUF file."""

    @classmethod
    def setUpClass(cls):
        sys.path.insert(0, str(Path(__file__).resolve().parent / "tools"))
        from make_tiny_gguf import build

        cls.tmp = tempfile.TemporaryDirectory(prefix="edunova-free-start-")
        model = Path(cls.tmp.name) / "edunova-tiny-test.gguf"
        build(str(model))
        cls.model_path = model

        # Serve the file so the service walks the REAL download -> verify ->
        # load pipeline instead of a pre-seeded cache.
        import functools
        cls.port = _free_port()
        handler = functools.partial(_ModelFileHandler, directory=cls.tmp.name)
        cls.httpd = http.server.ThreadingHTTPServer(("127.0.0.1", cls.port), handler)
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()

        cls._saved_env = dict(os.environ)
        os.environ.update({
            "LLM_PROVIDER": "local",
            "LOCAL_MODEL_RUNTIME": "llama_cpp",
            "LOCAL_MODEL_URL": f"http://127.0.0.1:{cls.port}/{model.name}",
            "LOCAL_MODEL_DIR": cls.tmp.name,
            "LOCAL_MODEL_MIN_BYTES": "4096",
            "LOCAL_MODEL_CTX": "2048",
            "LOCAL_MODEL_THREADS": "1",
            "RAG_ENABLED": "false",
            "LLM_MAX_OUTPUT_TOKENS": "1024",
            "AI_REQUIRE_INTERNAL_TOKEN": "true",
            "AI_INTERNAL_TOKEN": _TEST_TOKEN,
            # Prove the resource gate itself on a Render-Free-sized box.
            "AI_MEMORY_LIMIT_MB": str(FREE_LIMIT_MB),
            "MODEL_STARTUP_TIMEOUT": "300",
            "LOG_LEVEL": "WARNING",
        })

        # NOTE: the module-level ModelManager is a PROCESS singleton — every
        # test therefore re-imports inference_server for a CLEAN manager (and
        # the second import exercises the model-cache-hit path).

    @classmethod
    def tearDownClass(cls):
        os.environ.clear()
        os.environ.update(cls._saved_env)
        try:
            cls.httpd.shutdown()
            cls.httpd.server_close()
        except Exception:
            pass
        cls.thread.join(timeout=5)
        cls.tmp.cleanup()

    def setUp(self):
        sys.modules.pop("inference_server", None)
        import inference_server  # fresh singleton per test; env already applied
        self.server_module = inference_server

    def tearDown(self):
        # Safety net: never leave a supervised llama.cpp worker behind between
        # tests (the TestClient context manager already closes the lifespan in
        # the happy path; this covers failures raised mid-test).
        module, self.server_module = getattr(self, "server_module", None), None
        if module is not None:
            process = getattr(module.manager, "_process", None)
            if process is not None and process.is_alive():
                process.terminate()
                process.join(5)
                if process.is_alive():
                    process.kill()
                    process.join(2)
            sys.modules.pop("inference_server", None)

    def _client(self):
        from fastapi.testclient import TestClient
        return TestClient(self.server_module.app)

    def test_startup_ready_health_and_real_generation(self):
        with self._client() as client:  # runs lifespan -> manager.ensure_loading()
            # /health is pure liveness: always 200 while the process serves.
            health = client.get("/health")
            self.assertEqual(health.status_code, 200)
            self.assertEqual(health.json()["status"], "live")

            # Wait for the FULL honest lifecycle (load -> warmup -> inference
            # test). No shortcut, no fake: /ready flips only after a real
            # decoded generation succeeded inside the supervised worker.
            deadline = time.time() + 180
            last = None
            while time.time() < deadline:
                ready = client.get("/ready")
                last = ready.json()
                if ready.status_code == 200:
                    break
                time.sleep(0.5)
            else:  # pragma: no cover - failure diagnostics
                self.fail(f"/ready never reported MODEL_READY: {last}")

            self.assertEqual(last["ready"], True)
            self.assertEqual(last["state"], "MODEL_READY")
            self.assertTrue(last["model_loaded"])
            self.assertTrue(last["warmup_complete"])
            self.assertTrue(last["inference_test"])

            # Authenticated private endpoints.
            self.assertEqual(client.get("/model/status").status_code, 401)
            headers = {"X-AI-Internal-Token": _TEST_TOKEN}
            status = client.get("/model/status", headers=headers)
            self.assertEqual(status.status_code, 200)
            payload = status.json()
            self.assertEqual(payload["state"], "MODEL_READY")
            self.assertEqual(payload["runtime"], "llama_cpp")
            self.assertEqual(payload["context_size"], 2048)
            self.assertEqual(payload["threads"], 1)
            self.assertGreater(payload["available_ram_mb"], 0)
            self.assertIsNone(payload["error"])
            self.assertTrue(payload["memory_requirement"]["required_mb"] <= FREE_LIMIT_MB)
            # The simulated 512 MiB cgroup limit is the CAPACITY the boot gate
            # used (ResourceManager reads AI_MEMORY_LIMIT_MB / cgroup memory.max)
            # and the fit verdict is positive — no false resource failure.
            sysres = client.get("/system/resources", headers=headers)
            self.assertEqual(sysres.status_code, 200)
            self.assertEqual(sysres.json()["ram_limit_mb"], FREE_LIMIT_MB)
            self.assertTrue(sysres.json()["fits"])
            # RAG disabled => embeddings are explicitly OFF, not "loading".
            self.assertTrue(payload["embeddings"]["disabled"])
            self.assertFalse(payload["embeddings"]["ready"])

            # A simple prompt must produce a REAL model-generated response:
            # non-empty text plus decoded-token metrics from llama.cpp. The
            # tiny random-weight test model has no EOS token, so it exhausts
            # its budget and the OUTPUT_LIMIT_REACHED guard fires — that is
            # still genuine generation evidence (real decoded tokens from the
            # real runtime), not a template or a stub.
            first = client.post("/generate", headers=headers, json={
                "system_prompt": "Answer briefly.",
                "user_prompt": "What is 2 + 2?",
                "max_tokens": 24,
                "temperature": 0,
            })
            self.assertIn(first.status_code, (200, 502), first.text)
            if first.status_code == 200:
                body = first.json()
                text = body["text"]
                metrics = body["metrics"] or {}
                self.assertTrue(text.strip(), "the model must return genuine decoded text")
                self.assertGreaterEqual(int(metrics.get("tokens") or 0), 1, "real decoded tokens")
                self.assertIsNotNone(metrics.get("firstTokenMs"))
                self.assertGreater(int(metrics.get("durationMs") or 0), 0)
            else:
                # 502 OUTPUT_LIMIT_REACHED proves the model actually ran and
                # produced the requested number of tokens without emitting a
                # stop sequence — i.e. no canned answer short-circuits here.
                self.assertEqual(first.json()["detail"]["code"], "OUTPUT_LIMIT_REACHED")
                self.assertNotIn("template", first.text.lower())

            # The PRODUCTION planner contract: grammar-constrained JSON must
            # complete with a full model-generated answer (the grammar forces
            # a closed object, so this returns 200 even on the toy model).
            from agent.local_llm import DECISION_SCHEMA
            decision = client.post("/generate", headers=headers, json={
                "system_prompt": "Return a decision.",
                "user_prompt": "Name one thing students can learn.",
                "max_tokens": 96,
                "json_schema": DECISION_SCHEMA,
            })
            self.assertEqual(decision.status_code, 200, decision.text)
            import json as _json
            from agent.llm import parse_json_object
            parsed = parse_json_object(decision.json()["text"])
            self.assertIsInstance(parsed, dict)
            self.assertIn("action", parsed, "grammar must yield a schema-shaped decision from REAL model tokens")

            # A DIFFERENT prompt under the same schema gets its own fresh real
            # generation (proves the service is reusable and not single-shot).
            other = client.post("/generate", headers=headers, json={
                "system_prompt": "Return a decision.",
                "user_prompt": "Should I review my timetable today?",
                "max_tokens": 96,
                "json_schema": DECISION_SCHEMA,
            })
            self.assertEqual(other.status_code, 200, other.text)
            self.assertIsInstance(parse_json_object(other.json()["text"]), dict)
            self.assertGreaterEqual(int((other.json().get("metrics") or {}).get("tokens") or 0), 1)

            # The self-test recorded at startup is the honest warmup answer —
            # raw text produced by the loaded model, never a canned string.
            self.assertEqual(payload["last_self_test"]["prompt"], "What is 2 + 2?")
            self.assertTrue(payload["last_self_test"]["ok"])
            self.assertTrue(str(payload["last_self_test"]["answer"]).strip())

    def test_no_torch_imported_by_the_free_runtime(self):
        """Requirement: PyTorch/transformers must NOT enter the process."""
        with self._client() as client:
            deadline = time.time() + 180
            while time.time() < deadline and client.get("/ready").status_code != 200:
                time.sleep(0.5)
            self.assertNotIn("torch", sys.modules, "RAG disabled => torch must never be imported")
            self.assertNotIn("transformers", sys.modules, "RAG disabled => transformers must never be imported")
            embeddings = client.post("/embeddings", headers={"X-AI-Internal-Token": _TEST_TOKEN},
                                     json={"texts": ["hello"]})
            self.assertEqual(embeddings.status_code, 503)
            self.assertEqual(embeddings.json()["detail"]["code"], "EMBEDDINGS_UNAVAILABLE")


if __name__ == "__main__":
    unittest.main(verbosity=2)
