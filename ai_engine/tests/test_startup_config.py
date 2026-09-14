"""Startup configuration fail-fast for the EduNova AI service.

The AI service OWNS its model in-process by default (a missing
AI_INFERENCE_URL simply selects the owned-model topology), so the fail-fast
contract is now about the MODEL configuration itself:

1. Invalid self-hosted model configuration (in-process mode) -> MODEL_CONFIG_INVALID at startup.
2. Commercial provider configuration -> MODEL_CONFIG_INVALID.
3. Required but empty AI_INTERNAL_TOKEN (split mode) -> AI_INTERNAL_TOKEN_MISSING.
4. Correct configuration -> starts normally.
5. ``_inference_host()`` logs a host only (never the shared token).

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
        llm_provider="local",
        llm_configuration_error=None,
    )
    base.update(overrides)
    return types.SimpleNamespace(**base)


def test_invalid_model_config_is_fatal_in_inprocess_mode(monkeypatch):
    """Default (owned-model) topology: a broken model configuration aborts boot."""
    monkeypatch.setattr(main, "settings", _settings(inference_url="", llm_configuration_error="unknown file"))
    with pytest.raises(main.OrchestratorStartupError) as exc:
        main._require_runtime_configuration()
    assert exc.value.code == "MODEL_CONFIG_INVALID"


def test_missing_inference_url_selects_in_process_mode(monkeypatch):
    """A missing AI_INFERENCE_URL is the DEFAULT topology (owned model), not an error."""
    monkeypatch.setattr(main, "settings", _settings(inference_url=""))
    main._require_runtime_configuration()  # must not raise


def test_commercial_provider_is_fatal_in_inprocess_mode(monkeypatch):
    monkeypatch.setattr(main, "settings", _settings(inference_url="", llm_provider="openai"))
    with pytest.raises(main.OrchestratorStartupError) as exc:
        main._require_runtime_configuration()
    assert exc.value.code == "MODEL_CONFIG_INVALID"


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


def test_lifespan_aborts_startup_when_model_config_invalid(monkeypatch):
    """uvicorn runs the lifespan before serving: the process must die here."""
    from fastapi.testclient import TestClient

    monkeypatch.setattr(main, "settings", _settings(inference_url="", llm_configuration_error="bad model"))
    with pytest.raises(main.OrchestratorStartupError) as exc:
        with TestClient(main.app):
            pass  # pragma: no cover — startup must never get this far
    assert exc.value.code == "MODEL_CONFIG_INVALID"


def test_inference_host_never_leaks_the_token(monkeypatch):
    monkeypatch.setattr(
        main, "settings",
        _settings(inference_url="https://edunova-inference.example.onrender.com/"),
    )
    assert main._inference_host() == "edunova-inference.example.onrender.com"

    monkeypatch.setattr(main, "settings", _settings(inference_url=""))
    assert main._inference_host() == "in-process"

    monkeypatch.setattr(main, "settings", _settings(inference_url="http://secret-token@10.0.0.5:8002"))
    host = main._inference_host()
    assert "secret-token" not in host
    assert host.endswith("10.0.0.5:8002")
