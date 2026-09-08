"""Shared scoring helpers for Phase 4 routing / argument evaluation.

No keyword routers live here. Comparison is exact after light canonicalization.
"""

from __future__ import annotations

import json
import math
import re
from collections import Counter, defaultdict
from typing import Any, Iterable


def canonical_args(tool: str, arguments: dict[str, Any] | None) -> dict[str, Any]:
    """Drop empties, stringify scalars, strip calculator whitespace."""
    out: dict[str, Any] = {}
    for key, value in dict(arguments or {}).items():
        if value in (None, "", [], {}):
            continue
        if isinstance(value, str):
            value = value.strip()
            if not value:
                continue
        if tool == "calculator" and key == "expression":
            value = re.sub(r"\s+", "", str(value))
        if tool in {"open_url", "extract_webpage"} and key == "url":
            value = str(value).rstrip("/")
        out[str(key)] = value
    return out


def args_match(tool: str, expected: dict | None, predicted: dict | None) -> bool:
    """If expected is None, argument accuracy is not scored (returns True).

    If expected is {}, predicted must also canonicalize to {}.
    Otherwise predicted must equal expected after canonicalization.
    Extra predicted keys that are not in expected fail.
    """
    if expected is None:
        return True
    exp = canonical_args(tool, expected)
    pred = canonical_args(tool, predicted)
    return exp == pred


def confusion(pairs: Iterable[tuple[str, str]]) -> dict[str, dict[str, int]]:
    table: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    for gold, pred in pairs:
        table[gold][pred] += 1
    return {g: dict(p) for g, p in table.items()}


def per_tool_scores(pairs: list[tuple[str, str]], labels: list[str] | None = None) -> dict[str, dict[str, float]]:
    labels = labels or sorted({g for g, _ in pairs} | {p for _, p in pairs})
    gold_count = Counter(g for g, _ in pairs)
    pred_count = Counter(p for _, p in pairs)
    tp = Counter(g for g, p in pairs if g == p)
    out = {}
    for lab in labels:
        support = gold_count[lab]
        predicted = pred_count[lab]
        hit = tp[lab]
        precision = hit / predicted if predicted else 0.0
        recall = hit / support if support else 0.0
        f1 = (2 * precision * recall / (precision + recall)) if (precision + recall) else 0.0
        out[lab] = {
            "precision": round(precision, 4),
            "recall": round(recall, 4),
            "f1": round(f1, 4),
            "support": int(support),
            "predicted": int(predicted),
            "true_positives": int(hit),
        }
    return out


def aggregate_scores(per_tool: dict[str, dict[str, float]], pairs: list[tuple[str, str]]) -> dict[str, float]:
    n = len(pairs) or 1
    micro = sum(1 for g, p in pairs if g == p) / n
    tools_with_support = [v for v in per_tool.values() if v["support"] > 0]
    macro_acc = (
        sum(v["recall"] for v in tools_with_support) / len(tools_with_support) if tools_with_support else 0.0
    )
    macro_f1 = (
        sum(v["f1"] for v in tools_with_support) / len(tools_with_support) if tools_with_support else 0.0
    )
    total_support = sum(v["support"] for v in tools_with_support) or 1
    weighted_f1 = sum(v["f1"] * v["support"] for v in tools_with_support) / total_support
    return {
        "micro_accuracy": round(micro, 4),
        "macro_accuracy": round(macro_acc, 4),
        "macro_f1": round(macro_f1, 4),
        "weighted_f1": round(weighted_f1, 4),
        "n": len(pairs),
    }


def prediction_entropy(counts: Counter, n_classes: int) -> float:
    n = sum(counts.values()) or 1
    ent = 0.0
    for c in counts.values():
        p = c / n
        if p > 0:
            ent -= p * math.log(p, 2)
    return round(ent, 4)


def expected_entropy(n_classes: int) -> float:
    if n_classes <= 1:
        return 0.0
    return round(math.log(n_classes, 2), 4)


def kl_divergence(predicted: Counter, expected: Counter) -> float:
    """KL(predicted || expected) over the union of keys. Smoothed."""
    keys = set(predicted) | set(expected)
    n_p = sum(predicted.values()) + len(keys)
    n_e = sum(expected.values()) + len(keys)
    kl = 0.0
    for k in keys:
        p = (predicted[k] + 1) / n_p
        q = (expected[k] + 1) / n_e
        kl += p * math.log(p / q, 2)
    return round(kl, 4)


def mode_collapse_share(counts: Counter) -> tuple[str | None, float]:
    n = sum(counts.values()) or 1
    if not counts:
        return None, 0.0
    tool, c = counts.most_common(1)[0]
    return tool, round(c / n, 4)


def dumps(obj: Any) -> str:
    return json.dumps(obj, ensure_ascii=False, indent=2)
