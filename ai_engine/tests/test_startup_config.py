"""Startup configuration fail-fast for the lightweight orchestrator.

The orchestrator never loads the model, so a missing AI_INFERENCE_URL means it
cannot serve a single chat request. Before this behaviour existed the service
still booted, Render's ``/health`` returned 200 and the first student message
failed with a 503. These tests pin the fail-fast contract:

1. Missing AI_INFERENCE_URL  -> AI_INFERENCE_URL_MISSING, at startup.
2. Required but empty AI_INTERNAL_TOKEN -> AI_INTERNAL_TOKEN_MISSING.
3. Correct configuration -> starts normally.
4. ``_inference_host()`` logs a host only (never the shared token).

Run: python -m pytest ai_engine/tests/test_startup_config.py -q
"""

from __future__ import annotations

import sys
import types
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import main  # noqa: E402


def _settings(**overrides):
    base = dict(
        inference_url="https://edunova-inference.example.onrender.com",
        ai_require_internal_token=True,
        ai_internal_token="shared-token",
    )
    base.update(overrides)
    return types.SimpleNamespace(**base)


def test_missing_inference_url_is_fatal_at_startup(monkeypatch):
    monkeypatch.setattr(main, "settings", _settings(inference_url=""))
    with pytest.raises(main.OrchestratorStartupError) as exc:
        main._require_runtime_configuration()
    assert exc.value.code == "AI_INFERENCE_URL_MISSING"
    assert "AI_INFERENCE_URL" in str(exc.value)


def test_missing_internal_token_is_fatal_at_startup(monkeypatch):
    monkeypatch.setattr(main, "settings", _settings(ai_internal_token=""))
    with pytest.raises(main.OrchestratorStartupError) as exc:
        main._require_runtime_configuration()
    assert exc.value.code == "AI_INTERNAL_TOKEN_MISSING"


def test_internal_token_not_required_is_not_fatal(monkeypatch):
    monkeypatch.setattr(main, "settings", _settings(ai_require_internal_token=False, ai_internal_token=""))
    main._require_runtime_configuration()  # must not raise


def test_fully_configured_starts(monkeypatch):
    monkeypatch.setattr(main, "settings", _settings())
    main._require_runtime_configuration()  # must not raise


def test_lifespan_aborts_startup_when_inference_url_missing(monkeypatch):
    """uvicorn runs the lifespan before serving: the process must die here."""
    from fastapi.testclient import TestClient

    monkeypatch.setattr(main, "settings", _settings(inference_url=""))
    with pytest.raises(main.OrchestratorStartupError) as exc:
        with TestClient(main.app):
            pass  # pragma: no cover — startup must never get this far
    assert exc.value.code == "AI_INFERENCE_URL_MISSING"


def test_inference_host_never_leaks_the_token(monkeypatch):
    monkeypatch.setattr(
        main, "settings",
        _settings(inference_url="https://edunova-inference.example.onrender.com/"),
    )
    assert main._inference_host() == "edunova-inference.example.onrender.com"

    monkeypatch.setattr(main, "settings", _settings(inference_url=""))
    assert main._inference_host() == "unset"

    monkeypatch.setattr(main, "settings", _settings(inference_url="http://secret-token@10.0.0.5:8002"))
    host = main._inference_host()
    assert "secret-token" not in host
    assert host.endswith("10.0.0.5:8002")
