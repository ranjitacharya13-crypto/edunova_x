"""Configurable HRM sizes. Measured parameter counts are computed from the
architecture (not guessed). Presets target ~20/30/50/70/100 million params.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, fields
from pathlib import Path
from typing import Any


TASK_TYPES = (
    "DB_QUERY",
    "RAG_QUERY",
    "WEB_QUERY",
    "QUIZ",
    "STUDY_PLAN",
    "EXPLANATION",
    "AR",
    "SUMMARY",
    "MULTI_TOOL",
    "NEED_MORE_INFORMATION",
    "KNOWLEDGE",
    "ERROR",
)

TOOL_NAMES = (
    "none",
    "get_student_profile",
    "get_subjects",
    "get_timetable",
    "get_today_schedule",
    "get_upcoming_classes",
    "get_syllabus",
    "get_learning_materials",
    "get_progress",
    "get_study_history",
    "get_quiz_history",
    "get_quiz_results",
    "get_assignments",
    "get_exams",
    "get_attendance",
    "get_notes",
    "get_goals",
    "get_upcoming_events",
    "get_notifications",
    "retrieve_learning_materials",
    "web_search",
    "open_url",
    "extract_webpage",
    "calculator",
    "get_current_datetime",
    "get_ar_lessons",
    "create_quiz",
    "save_quiz",
    "create_study_plan",
    "open_feature",
)

OUTPUT_TYPE_NAMES = (
    "FINAL_ANSWER",
    "TOOL_CALL",
    "TOOL_RESULT",
    "SEARCH_REQUEST",
    "QUIZ",
    "STUDY_PLAN",
    "AR_SCENE",
    "SUMMARY",
    "ERROR",
    "NEED_MORE_INFORMATION",
    "NO_RELEVANT_CONTEXT",
    "WEB_SEARCH_UNAVAILABLE",
    "TOOL_ERROR",
)


@dataclass
class HRMConfig:
    name: str = "edunova-hrm-20m"
    architecture_version: str = "hrm-v1"
    vocab_size: int = 4096
    d_model: int = 384
    n_heads: int = 6
    high_level_layers: int = 3
    low_level_layers: int = 6
    ffn_mult: int = 4
    max_seq_len: int = 512
    dropout: float = 0.0
    rope_theta: float = 10000.0
    tie_embeddings: bool = False
    gradient_checkpointing: bool = False
    n_task_types: int = len(TASK_TYPES)
    n_tools: int = len(TOOL_NAMES)
    n_output_types: int = len(OUTPUT_TYPE_NAMES)
    pad_id: int = 0
    bos_id: int = 1
    eos_id: int = 2
    unk_id: int = 3

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "HRMConfig":
        allowed = {f.name for f in fields(cls)}
        return cls(**{k: v for k, v in data.items() if k in allowed})

    def estimate_parameters(self) -> int:
        """Closed-form count matching EduNovaHRM construction (no torch)."""
        d = self.d_model
        ff = d * self.ffn_mult
        # RMSNorm: 1 * d
        # Attention: q,k,v,o = 4 * d * d (bias-free)
        # FFN (GELU): 2 * d * ff (bias-free)
        block = (2 * d) + (4 * d * d) + (2 * d * ff)
        high = self.high_level_layers * (block + (2 * d * d))  # + cross-free encoder; extra 0
        # High-level is encoder-only (no cross-attn). Low-level has extra cross-attn.
        high = self.high_level_layers * block
        # Low-level decoder block = self-attn + cross-attn + ffn + 3 norms
        low_block = (3 * d) + (4 * d * d) + (4 * d * d) + (2 * d * ff)
        low = self.low_level_layers * low_block
        emb = self.vocab_size * d
        lm = 0 if self.tie_embeddings else self.vocab_size * d
        heads = (d * self.n_task_types) + (d * self.n_tools) + (d * self.n_output_types) + (d * 2)
        # high-level summary proj + tool-conditioning embedding
        heads += d * d
        heads += self.n_tools * d
        return emb + high + low + lm + heads


SIZE_PRESETS: dict[str, HRMConfig] = {
    "20m": HRMConfig(name="edunova-hrm-20m", d_model=384, n_heads=6, high_level_layers=3, low_level_layers=6, vocab_size=4096),
    "30m": HRMConfig(name="edunova-hrm-30m", d_model=448, n_heads=7, high_level_layers=4, low_level_layers=8, vocab_size=4096),
    "50m": HRMConfig(name="edunova-hrm-50m", d_model=512, n_heads=8, high_level_layers=4, low_level_layers=10, vocab_size=4096),
    "70m": HRMConfig(name="edunova-hrm-70m", d_model=576, n_heads=9, high_level_layers=6, low_level_layers=10, vocab_size=4096),
    "100m": HRMConfig(name="edunova-hrm-100m", d_model=640, n_heads=10, high_level_layers=6, low_level_layers=12, vocab_size=4096),
}


def _parse_simple_yaml(text: str) -> dict[str, Any]:
    """Minimal YAML subset (mappings + lists) so training configs do not need PyYAML."""
    lines = [ln.rstrip() for ln in text.splitlines() if ln.strip() and not ln.strip().startswith("#")]
    root: dict[str, Any] = {}
    stack: list[tuple[int, Any]] = [(-1, root)]
    pending_key: tuple[int, dict[str, Any], str] | None = None

    def _coerce(raw: str) -> Any:
        raw = raw.strip()
        if raw in {"true", "True"}:
            return True
        if raw in {"false", "False"}:
            return False
        if raw in {"null", "None", "~"}:
            return None
        if raw.startswith("\"") and raw.endswith("\""):
            return raw[1:-1]
        if raw.startswith("'") and raw.endswith("'"):
            return raw[1:-1]
        try:
            if "." in raw:
                return float(raw)
            return int(raw)
        except ValueError:
            return raw

    for line in lines:
        indent = len(line) - len(line.lstrip(" "))
        while stack and indent <= stack[-1][0]:
            stack.pop()
        parent = stack[-1][1]
        stripped = line.lstrip(" ")
        if stripped.startswith("- "):
            item = _coerce(stripped[2:])
            if not isinstance(parent, list):
                if pending_key is not None:
                    _, pdict, key = pending_key
                    lst: list[Any] = []
                    pdict[key] = lst
                    parent = lst
                    stack.append((indent, lst))
                    pending_key = None
                else:
                    raise ValueError("list item without a parent key")
            parent.append(item)
            continue
        if ":" not in stripped:
            continue
        key, _, rest = stripped.partition(":")
        key = key.strip()
        rest = rest.strip()
        if rest == "":
            child: dict[str, Any] = {}
            parent[key] = child
            stack.append((indent, child))
            pending_key = (indent, parent, key)
        else:
            parent[key] = _coerce(rest)
            pending_key = None
    return root


def load_hrm_config(path: str | Path | None = None, size: str | None = None) -> HRMConfig:
    if size:
        key = size.lower().rstrip("m") + "m" if not size.lower().endswith("m") else size.lower()
        if key not in SIZE_PRESETS:
            raise ValueError(f"Unknown size preset {size!r}. Choose from {sorted(SIZE_PRESETS)}")
        cfg = SIZE_PRESETS[key]
        if path:
            data = _parse_simple_yaml(Path(path).read_text(encoding="utf-8"))
            merged = {**cfg.to_dict(), **{k: v for k, v in data.items() if v is not None}}
            return HRMConfig.from_dict(merged)
        return cfg
    if path:
        data = _parse_simple_yaml(Path(path).read_text(encoding="utf-8"))
        preset = str(data.get("preset") or data.get("size") or "").lower()
        base = SIZE_PRESETS.get(preset, HRMConfig()).to_dict()
        base.update({k: v for k, v in data.items() if k not in {"preset", "size"}})
        return HRMConfig.from_dict(base)
    return SIZE_PRESETS["20m"]
