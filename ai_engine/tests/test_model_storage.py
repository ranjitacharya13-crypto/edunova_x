"""Model storage lifecycle tests — the 2026-09 MODEL_DOWNLOAD_FAILED repair.

Production incident this suite locks down:

    LOCAL_MODEL_DIR=/var/data/models on a Render FREE (native Python) instance
    -> ``mkdir /var/data/models`` failed (no permission under /var, and no
       persistent disk is possible on the free plan)
    -> the failure surfaced from the DOWNLOAD stage as a generic
       ``MODEL_DOWNLOAD_FAILED`` with "model cache directory is not writable".

The contract now under test:

1. ``LocalModelManager.validate_storage`` proves the cache directory with real
   probes (mkdir + write + read + rename + delete) and a free-space check
   BEFORE any network access.
2. An unusable directory fails as ``MODEL_STORAGE_NOT_WRITABLE`` (or
   ``MODEL_STORAGE_INSUFFICIENT_DISK``) — a SPECIFIC code naming the exact
   path, never a generic download failure.
3. The supervisor (``ModelManager.ensure_loading``) performs the same
   validation in the parent process before any worker is spawned, so the
   service fails in milliseconds with an honest terminal state.
4. No partially-downloaded artifact is ever exposed: a failed download leaves
   no ``.part`` file and no model file behind.

Run: python -m unittest ai_engine.tests.test_model_storage -v
"""

from __future__ import annotations

import asyncio
import os
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from agent.local_llm import (  # noqa: E402
    CODE_MODEL_STORAGE_INSUFFICIENT_DISK,
    CODE_MODEL_STORAGE_NOT_WRITABLE,
    LocalModelManager,
    ModelSourceError,
)
from config import Settings  # noqa: E402
from inference.manager import FAILURES, ModelManager  # noqa: E402
from inference.inprocess import InProcessLLM  # noqa: E402

RUNNING_AS_ROOT = os.geteuid() == 0


def storage_settings(**overrides) -> Settings:
    base = dict(
        llm_provider="local",
        local_model_repo="QuantFactory/SmolLM2-135M-Instruct-GGUF",
        local_model_file="SmolLM2-135M-Instruct.Q4_1.gguf",
    )
    base.update(overrides)
    return Settings(**base)


class StorageValidationTests(unittest.TestCase):
    def test_writable_directory_passes_full_probe_chain(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "nested" / "models_cache"
            manager = LocalModelManager(storage_settings(local_model_dir=str(target)))
            report = manager.validate_storage()
            self.assertTrue(report["writable"])
            self.assertTrue(target.exists())
            self.assertEqual(
                report["probes"], ["mkdir", "write", "read", "rename", "delete"]
            )
            self.assertGreater(report["freeBytes"], 0)
            # The pinned catalogue size (98,362,432 B) is the requirement.
            self.assertEqual(report["requiredBytes"], 98_362_432)
            self.assertEqual(report["path"], str(target))
            # Probes clean up after themselves: no artifacts left behind.
            self.assertEqual(list(target.iterdir()), [])

    def test_readonly_existing_directory_fails_with_exact_path(self):
        if RUNNING_AS_ROOT:
            self.skipTest("chmod-based permission checks do not bind for root")
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "readonly"
            target.mkdir()
            target.chmod(0o555)
            manager = LocalModelManager(storage_settings(local_model_dir=str(target)))
            with self.assertRaises(ModelSourceError) as ctx:
                manager.validate_storage()
            error = ctx.exception
            self.assertEqual(error.code, CODE_MODEL_STORAGE_NOT_WRITABLE)
            self.assertEqual(error.stage, "storage")
            self.assertTrue(error.permanent)
            self.assertIn(str(target), error.reason)
            self.assertIn("LOCAL_MODEL_DIR", error.hint)

    def test_production_incident_path_fails_not_writable(self):
        """The exact /var/data/models deployment must fail loudly, not as 404/download.

        Render free instances cannot create directories under /var; this test
        reproduces the production conditions on any non-root runner.
        """
        if RUNNING_AS_ROOT or Path("/var/data").exists():
            self.skipTest("only meaningful as a non-root user without /var/data")
        manager = LocalModelManager(storage_settings(local_model_dir="/var/data/models"))
        with self.assertRaises(ModelSourceError) as ctx:
            manager.validate_storage()
        self.assertEqual(ctx.exception.code, CODE_MODEL_STORAGE_NOT_WRITABLE)
        self.assertIn("/var/data/models", ctx.exception.reason)
        rendered = ctx.exception.render()
        self.assertIn("MODEL_STARTUP_ERROR", rendered)
        self.assertIn(f"Code: {CODE_MODEL_STORAGE_NOT_WRITABLE}", rendered)
        self.assertIn("Stage: storage", rendered)

    def test_insufficient_disk_fails_with_numbers(self):
        with tempfile.TemporaryDirectory() as tmp:
            manager = LocalModelManager(storage_settings(local_model_dir=str(Path(tmp) / "cache")))
            real_usage = shutil.disk_usage("/")

            def fake_disk_usage(_path):
                return real_usage._replace(free=10 * 1024 * 1024)

            with patch("agent.local_llm.shutil.disk_usage", fake_disk_usage):
                with self.assertRaises(ModelSourceError) as ctx:
                    manager.validate_storage()
            error = ctx.exception
            self.assertEqual(error.code, CODE_MODEL_STORAGE_INSUFFICIENT_DISK)
            self.assertEqual(error.stage, "storage")
            # The real free/needed numbers must be in the message.
            self.assertIn("10485760 bytes free", error.reason)

    def test_probe_rename_failure_is_reported(self):
        with tempfile.TemporaryDirectory() as tmp:
            manager = LocalModelManager(storage_settings(local_model_dir=str(Path(tmp) / "cache")))

            def broken_replace(self, target):  # noqa: ANN001
                raise OSError(13, "Permission denied")

            with patch.object(Path, "replace", broken_replace):
                with self.assertRaises(ModelSourceError) as ctx:
                    manager.validate_storage()
            self.assertEqual(ctx.exception.code, CODE_MODEL_STORAGE_NOT_WRITABLE)
            self.assertIn("rename", ctx.exception.reason)

    def test_download_never_starts_when_storage_is_unusable(self):
        """Storage is validated BEFORE any network access — the ordering fix."""
        if RUNNING_AS_ROOT:
            self.skipTest("chmod-based permission checks do not bind for root")
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "readonly"
            target.mkdir()
            target.chmod(0o555)
            # An unreachable host: if the code touched the network first the
            # failure would be MODEL_NETWORK_FAILED, not MODEL_STORAGE_*.
            settings = storage_settings(
                local_model_dir=str(target),
                local_model_url="http://127.0.0.2:9/model.gguf",  # closed loopback port: instant refusal
                local_model_download_retries=0,
            )
            manager = LocalModelManager(settings)
            with self.assertRaises(ModelSourceError) as ctx:
                asyncio.run(manager._download_if_needed())
            self.assertEqual(ctx.exception.code, CODE_MODEL_STORAGE_NOT_WRITABLE)
            # And no partial artifact was left behind.
            self.assertFalse(list(target.glob("*.part")))

    def test_failed_download_leaves_no_partial_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            settings = storage_settings(
                local_model_dir=str(Path(tmp) / "cache"),
                local_model_url="http://127.0.0.2:9/model.gguf",  # closed loopback port: instant refusal
                local_model_download_retries=0,
                local_model_download_timeout=60,
            )
            manager = LocalModelManager(settings)
            with self.assertRaises(ModelSourceError) as ctx:
                asyncio.run(manager._download_if_needed())
            # Network failures are classified as network, never as storage.
            self.assertEqual(ctx.exception.code, "MODEL_NETWORK_FAILED")
            cache = Path(tmp) / "cache"
            self.assertFalse(list(cache.glob("*.part")))
            self.assertFalse(list(cache.glob("*.gguf")))

    def test_storage_report_is_read_only_and_informative(self):
        with tempfile.TemporaryDirectory() as tmp:
            manager = LocalModelManager(storage_settings(local_model_dir=str(Path(tmp) / "cache")))
            report = manager.storage_report()
            self.assertEqual(report["exists"], False)  # did NOT create anything
            self.assertEqual(report["expectedModelBytes"], 98_362_432)
            manager.validate_storage()
            report = manager.storage_report()
            self.assertEqual(report["exists"], True)
            self.assertIsNotNone(report["freeBytes"])
            self.assertIsNotNone(report["lastCheck"])


class SupervisorStorageTests(unittest.TestCase):
    """The parent process fails fast on an unusable cache directory."""

    def _run(self, coro):
        return asyncio.run(coro)

    def test_ensure_loading_fails_fast_without_spawning_a_worker(self):
        if RUNNING_AS_ROOT or Path("/var/data").exists():
            self.skipTest("only meaningful as a non-root user without /var/data")
        manager = ModelManager(storage_settings(local_model_dir="/var/data/models"))
        try:
            manager.ensure_loading()
            self.assertEqual(manager.phase, "MODEL_STORAGE_NOT_WRITABLE")
            self.assertIn("MODEL_STORAGE_NOT_WRITABLE", FAILURES)
            self.assertEqual(manager.public_state, "MODEL_FAILED")
            self.assertTrue(manager.snapshot()["permanentFailure"])
            self.assertIn("/var/data/models", manager.last_error)
            # No worker was spawned for a storage bug — fail-fast contract.
            self.assertIsNone(manager._process)
            self.assertFalse(manager.is_ready())
        finally:
            self._run(manager.close())

    def test_insufficient_disk_fails_fast_without_spawning_a_worker(self):
        with tempfile.TemporaryDirectory() as tmp:
            manager = ModelManager(storage_settings(local_model_dir=str(Path(tmp) / "cache")))
            real_usage = shutil.disk_usage("/")

            def fake_disk_usage(_path):
                return real_usage._replace(free=1024)

            with patch("agent.local_llm.shutil.disk_usage", fake_disk_usage):
                try:
                    manager.ensure_loading()
                    self.assertEqual(manager.phase, "MODEL_STORAGE_INSUFFICIENT_DISK")
                    self.assertEqual(manager.public_state, "MODEL_FAILED")
                    self.assertIsNone(manager._process)
                finally:
                    self._run(manager.close())

    def test_storage_report_surfaces_in_model_status_payload(self):
        if RUNNING_AS_ROOT or Path("/var/data").exists():
            self.skipTest("only meaningful as a non-root user without /var/data")
        engine = InProcessLLM(storage_settings(local_model_dir="/var/data/models"))
        engine.manager.ensure_loading()
        try:
            payload = self._run(engine.status())
            self.assertEqual(payload["errorStage"], "MODEL_STORAGE_NOT_WRITABLE")
            self.assertFalse(payload["ready"])
            # The honest public error names the storage stage, not a download.
            from main import _public_error

            public = _public_error(payload)
            self.assertEqual(public["code"], "MODEL_STORAGE_NOT_WRITABLE")
        finally:
            self._run(engine.close())


if __name__ == "__main__":
    unittest.main()
