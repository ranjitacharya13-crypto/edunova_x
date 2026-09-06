"""Canonical model lifecycle for the EduNova AI inference service.

A model instance moves through the lifecycle **before** it accepts normal
inference traffic:

    STARTING
       -> DOWNLOADING (first boot only, background)
       -> LOADING     (weights -> memory, background)
       -> WARMING     (one real warm-up inference)
       -> READY       (accepting chat traffic)

While a generation is running the instance is BUSY (single-flight on a small
CPU).  DEGRADED marks a model that is still usable but operating under reduced
conditions (e.g. the embeddings/RAG runtime failed but the core LLM works).
ERROR is a terminal state from which the runtime may retry after a cooldown.

The legacy string vocabulary used by the pre-existing health endpoints
(``not_started`` / ``downloading`` / ``loading`` / ``ready`` / ``error``) is
kept as the primary ``state`` value so that existing consumers keep working;
``lifecycle`` exposes the canonical name alongside it.
"""

from __future__ import annotations

from dataclasses import dataclass, field
import time
from typing import Any

# Canonical lifecycle states.
STARTING = "STARTING"
DOWNLOADING = "DOWNLOADING"
LOADING = "LOADING"
WARMING = "WARMING"
READY = "READY"
BUSY = "BUSY"
DEGRADED = "DEGRADED"
ERROR = "ERROR"

LIFECYCLE_STATES: tuple[str, ...] = (
    STARTING,
    DOWNLOADING,
    LOADING,
    WARMING,
    READY,
    BUSY,
    DEGRADED,
    ERROR,
)

# Legacy state vocabulary (kept for the existing health/UI consumers).
LEGACY_STATES = {
    "not_started": STARTING,
    "downloading": DOWNLOADING,
    "loading": LOADING,
    "warming": WARMING,
    "ready": READY,
    "busy": BUSY,
    "degraded": DEGRADED,
    "error": ERROR,
}

_STARTING_LEGACY = {
    "starting": "loading",
    "model_loading": "loading",
    "cold": "loading",
}

READY_LEGACY = {"ready", "model_ready"}

STARTING_STATES = {DOWNLOADING, LOADING, WARMING, STARTING}


def canonical_from_legacy(state: str) -> str:
    """Map any legacy/external state spelling onto a canonical state."""
    key = str(state or "").strip().lower()
    if key in LEGACY_STATES:
        return LEGACY_STATES[key]
    if key in _STARTING_LEGACY:
        return LOADING
    if key in READY_LEGACY:
        return READY
    return STARTING


def legacy_from_canonical(state: str) -> str:
    """Map a canonical state onto the legacy lowercase vocabulary."""
    mapping = {
        STARTING: "loading",
        DOWNLOADING: "downloading",
        LOADING: "loading",
        WARMING: "loading",
        READY: "ready",
        BUSY: "ready",
        DEGRADED: "degraded",
        ERROR: "error",
    }
    return mapping.get(state, "loading")


@dataclass(slots=True)
class ModelLifecycle:
    """Small state machine tracking lifecycle transitions + timestamps."""

    state: str = STARTING
    changed_at: float = field(default_factory=time.time)
    entered_at: dict[str, float] = field(default_factory=dict)
    history: list[dict[str, Any]] = field(default_factory=list)

    def transition(self, new_state: str, note: str = "") -> str:
        new_state = new_state.upper()
        if new_state not in LIFECYCLE_STATES:
            raise ValueError(f"unknown lifecycle state {new_state!r}")
        if new_state == self.state:
            return self.state
        now = time.time()
        self.history.append(
            {
                "from": self.state,
                "to": new_state,
                "at": now,
                "note": str(note)[:200],
            }
        )
        self.state = new_state
        self.changed_at = now
        self.entered_at[new_state] = now
        if len(self.history) > 64:
            self.history = self.history[-64:]
        return self.state

    @property
    def legacy(self) -> str:
        """Lowercase legacy state for existing health consumers."""
        return legacy_from_canonical(self.state)

    def started_at(self, canonical: str) -> float | None:
        return self.entered_at.get(canonical.upper())

    def snapshot(self) -> dict[str, Any]:
        return {
            "lifecycle": self.state,
            "state": self.legacy,
            "changedAt": self.changed_at,
            "enteredAt": {k: v for k, v in self.entered_at.items()},
        }

    def view(self) -> str:
        return self.state


def state_machine_view(lifecycle: ModelLifecycle | None) -> dict[str, Any]:
    if lifecycle is None:
        return {"lifecycle": "unknown", "state": "unknown"}
    return lifecycle.snapshot()
