"""Model registry with lineage and rollback. No irreversible promotion."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_PATH = ROOT / "post_training" / "registry" / "registry.json"


class ModelRegistry:
    def __init__(self, path: Path | None = None):
        self.path = path or DEFAULT_PATH
        self.path.parent.mkdir(parents=True, exist_ok=True)
        if self.path.exists():
            self.data = json.loads(self.path.read_text(encoding="utf-8"))
        else:
            self.data = {"production": None, "history": [], "models": {}}

    def save(self) -> None:
        self.path.write_text(json.dumps(self.data, indent=2), encoding="utf-8")

    def register(
        self,
        version: str,
        *,
        architecture_version: str,
        tokenizer_version: str,
        dataset_version: str,
        training_stage: str,
        training_config: str,
        checkpoint: str,
        parent: str | None = None,
        evaluation: dict[str, Any] | None = None,
        adapters: list[str] | None = None,
    ) -> dict[str, Any]:
        record = {
            "model_version": version,
            "architecture_version": architecture_version,
            "tokenizer_version": tokenizer_version,
            "dataset_version": dataset_version,
            "training_stage": training_stage,
            "training_configuration": training_config,
            "checkpoint": checkpoint,
            "parent_model": parent,
            "adapters": adapters or [],
            "evaluation": evaluation or {},
            "date": datetime.now(timezone.utc).isoformat(),
        }
        self.data["models"][version] = record
        self.data["history"].append({"event": "register", "version": version, "date": record["date"]})
        self.save()
        return record

    def promote(self, version: str, *, min_tool_accuracy: float = 0.0, require_no_regression: bool = True) -> dict[str, Any]:
        if version not in self.data["models"]:
            raise KeyError(version)
        candidate = self.data["models"][version]
        current = self.data.get("production")
        evals = candidate.get("evaluation") or {}
        if evals.get("tool_selection_accuracy", 1.0) < min_tool_accuracy:
            raise ValueError("REFUSED_PROMOTION: tool_selection_accuracy below threshold")
        if require_no_regression and current and current in self.data["models"]:
            prev = (self.data["models"][current].get("evaluation") or {}).get("tool_selection_accuracy", 0)
            new = evals.get("tool_selection_accuracy", 0)
            # A quiz-only gain must not hide a tool-selection regression.
            if new + 1e-9 < prev:
                raise ValueError(
                    f"REFUSED_PROMOTION: {version} tool accuracy {new} < production {current} {prev}"
                )
        previous = self.data.get("production")
        self.data["production"] = version
        self.data["history"].append({"event": "promote", "version": version, "previous": previous})
        self.save()
        return candidate

    def rollback(self, version: str | None = None) -> str:
        if version is None:
            for event in reversed(self.data["history"]):
                if event.get("event") == "promote" and event.get("previous"):
                    version = event["previous"]
                    break
        if not version or version not in self.data["models"]:
            raise ValueError("No rollback target")
        self.data["production"] = version
        self.data["history"].append({"event": "rollback", "version": version})
        self.save()
        return version

    def production(self) -> dict[str, Any] | None:
        ver = self.data.get("production")
        return self.data["models"].get(ver) if ver else None
