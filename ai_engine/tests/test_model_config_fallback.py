"""Regression tests for the production model-config self-heal.

The incident: an environment override pinned ``LOCAL_MODEL_FILE`` to a
filename that was never published in the configured HuggingFace repository.
The startup preflight returned a permanent HTTP 404 and the AI service stayed
down with "self-hosted model is not available on the server".

The fix under test: when the configured file *provably* does not exist in a
repository from the verified catalogue, the runtime transparently falls back
to that repo's catalogue-verified default file (still a real self-hosted GGUF,
integrity-pinned) instead of bricking the service — loudly logged and exposed
through health as ``configOverrideRejected``.
"""

from __future__ import annotations

import asyncio
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from agent.local_llm import LocalModelManager, ModelSourceError  # noqa: E402
from config import (  # noqa: E402
    DEFAULT_LOCAL_MODEL_FILE,
    DEFAULT_LOCAL_MODEL_REPO,
    Settings,
    catalogue_default_file_for_repo,
    known_model_entry,
)


def _source_404() -> ModelSourceError:
    return ModelSourceError(
        model="stale-override",
        url="https://example.invalid/stale.gguf",
        reason="model file not found at the configured URL",
        status=404,
        stage="preflight",
        permanent=True,
    )


class CatalogueHelperTests(unittest.TestCase):
    def test_default_repo_maps_to_default_file(self):
        self.assertEqual(
            catalogue_default_file_for_repo(DEFAULT_LOCAL_MODEL_REPO),
            DEFAULT_LOCAL_MODEL_FILE,
        )

    def test_unknown_repo_has_no_default(self):
        self.assertIsNone(catalogue_default_file_for_repo("some-org/unknown-repo"))
        self.assertIsNone(catalogue_default_file_for_repo(""))

    def test_known_entry_roundtrip(self):
        entry = known_model_entry(DEFAULT_LOCAL_MODEL_REPO, DEFAULT_LOCAL_MODEL_FILE)
        self.assertIsNotNone(entry)
        self.assertIn("sha256", entry)
        self.assertIn("bytes", entry)


class _RecordingManager(LocalModelManager):
    """LocalModelManager with the network/llama steps stubbed out."""

    def __init__(self, settings: Settings, fail_first_download: bool = True):
        super().__init__(settings)
        self._fail_first_download = fail_first_download
        self.download_calls = 0
        self.load_calls = 0

    async def _download_if_needed(self) -> None:  # noqa: D102 - test stub
        self.download_calls += 1
        if self._fail_first_download and self.download_calls == 1:
            raise _source_404()
        self.file_size_bytes = 1234

    async def _load_model(self) -> None:  # noqa: D102 - test stub
        self.load_calls += 1
        self._llama = object()


class OverrideFallbackTests(unittest.TestCase):
    def test_stale_override_file_404_falls_back_to_catalogue(self):
        # The production incident: a file that never existed in the repo.
        settings = Settings(
            local_model_repo=DEFAULT_LOCAL_MODEL_REPO,
            local_model_file="Qwen2.5-0.5B-Instruct-IQ3_XXS.gguf",
        )
        manager = _RecordingManager(settings)
        asyncio.run(manager._load_pipeline())

        self.assertEqual(manager.state, "ready")
        self.assertIsNotNone(manager._llama)
        self.assertEqual(manager.download_calls, 2)  # failed attempt + healed retry
        # Settings were re-pointed at the verified catalogue file.
        self.assertEqual(manager.settings.local_model_file, DEFAULT_LOCAL_MODEL_FILE)
        # The rejection is recorded and never hidden.
        self.assertIsNotNone(manager.config_override_rejected)
        rejected = manager.config_override_rejected
        self.assertEqual(rejected["configuredFile"], "Qwen2.5-0.5B-Instruct-IQ3_XXS.gguf")
        self.assertEqual(rejected["status"], 404)
        self.assertEqual(rejected["fallbackFile"], DEFAULT_LOCAL_MODEL_FILE)
        # Integrity pinning from the catalogue now applies.
        self.assertEqual(manager.settings.local_model_expected_sha256, known_model_entry(
            DEFAULT_LOCAL_MODEL_REPO, DEFAULT_LOCAL_MODEL_FILE
        )["sha256"])

    def test_catalogue_file_404_does_not_fall_back(self):
        # If a verified, integrity-pinned file 404s, that is an upstream outage:
        # it must stay a loud error, never silently re-pointed.
        settings = Settings(
            local_model_repo=DEFAULT_LOCAL_MODEL_REPO,
            local_model_file=DEFAULT_LOCAL_MODEL_FILE,
        )
        manager = _RecordingManager(settings)
        asyncio.run(manager._load_pipeline())

        self.assertEqual(manager.state, "error")
        self.assertIsNone(manager.config_override_rejected)
        self.assertEqual(manager.download_calls, 1)
        self.assertEqual(manager.load_calls, 0)

    def test_custom_url_404_never_falls_back(self):
        # A custom LOCAL_MODEL_URL is a deliberate operator choice.
        settings = Settings(
            local_model_url="http://127.0.0.1:9/stale.gguf",
        )
        manager = _RecordingManager(settings)
        asyncio.run(manager._load_pipeline())

        self.assertEqual(manager.state, "error")
        self.assertIsNone(manager.config_override_rejected)
        self.assertEqual(manager.download_calls, 1)

    def test_fallback_runs_only_once(self):
        settings = Settings(
            local_model_repo=DEFAULT_LOCAL_MODEL_REPO,
            local_model_file="Qwen2.5-0.5B-Instruct-IQ3_XXS.gguf",
        )
        manager = _RecordingManager(settings, fail_first_download=False)
        # Simulate: even after the fallback the (unknown) failure repeats —
        # the recovery must not loop forever.
        original = manager._download_if_needed

        async def always_fails():
            manager.download_calls += 1
            raise _source_404()

        manager._download_if_needed = always_fails  # type: ignore[method-assign]
        asyncio.run(manager._load_pipeline())
        self.assertEqual(manager.state, "error")
        # 1st attempt (configured file) + 1 healed attempt, then it stops.
        self.assertEqual(manager.download_calls, 2)
        self.assertIsNotNone(manager.config_override_rejected)
        del original

    def test_snapshot_exposes_override_state(self):
        settings = Settings(
            local_model_repo=DEFAULT_LOCAL_MODEL_REPO,
            local_model_file="Qwen2.5-0.5B-Instruct-IQ3_XXS.gguf",
        )
        manager = _RecordingManager(settings)
        asyncio.run(manager._load_pipeline())

        public_view = manager.snapshot(include_source=False)
        self.assertTrue(public_view["overrideRejected"])
        self.assertTrue(public_view["ready"])

        internal_view = manager.snapshot(include_source=True)
        self.assertIsNotNone(internal_view.get("configOverrideRejected"))
        self.assertEqual(
            internal_view["configOverrideRejected"]["fallbackFile"],
            DEFAULT_LOCAL_MODEL_FILE,
        )
        # modelId in the snapshot reflects the file that will actually load.
        self.assertEqual(internal_view["modelId"], manager.settings.local_model_id)


if __name__ == "__main__":
    unittest.main()
