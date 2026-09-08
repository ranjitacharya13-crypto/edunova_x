#!/usr/bin/env python3
"""Phase 4 routing diagnosis for EduNova HRM.

Evaluates the SAME prompt three ways (never mixed into one score):

  A. High-level tool head          (encoder → classification)
  B. Autoregressive generation     (model-only, temperature 0)
  C. Oracle tool conditioning      (decoder given the gold tool id)

Also reports argument accuracy, JSON/schema, confusion, per-tool F1,
mode-collapse / entropy, and a mocked end-to-end workflow check.

    python evaluation/phase4_eval.py \
        --checkpoint post_training/checkpoints/edunova-hrm-20m-sft \
        --out docs/results/hrm-phase4-eval.json
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "ai_engine"))
sys.path.insert(0, str(ROOT / "evaluation"))
sys.path.insert(0, str(ROOT / "evaluation" / "structured_output"))

from golden import GOLDEN_CASES  # noqa: E402
from hrm.config import TOOL_NAMES  # noqa: E402
from hrm.outputs import StructuredOutputError, parse_structured_output  # noqa: E402
from metrics import (  # noqa: E402
    aggregate_scores,
    args_match,
    confusion,
    expected_entropy,
    kl_divergence,
    mode_collapse_share,
    per_tool_scores,
    prediction_entropy,
)
from eval_structured import Evaluator, make_constrained_bias, schema_check, strict_json_ok  # noqa: E402


def _load_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        return []
    return [json.loads(l) for l in path.read_text(encoding="utf-8").splitlines() if l.strip()]


def _tool_id(name: str) -> int | None:
    try:
        return TOOL_NAMES.index(name)
    except ValueError:
        return None


def _extract(text: str) -> tuple[bool, bool, str | None, dict | None, str]:
    syntax = strict_json_ok(text)
    try:
        parsed = parse_structured_output(text)
        schema_ok = True
        kind = parsed.type
        tool = parsed.payload.get("tool")
        arguments = parsed.payload.get("arguments") if isinstance(parsed.payload.get("arguments"), dict) else {}
        if kind in {"FINAL_ANSWER", "SUMMARY", "NEED_MORE_INFORMATION", "ERROR"}:
            tool = tool or "none"
    except StructuredOutputError:
        schema_ok, kind, tool = schema_check(text)
        arguments = {}
        if not tool:
            tool = None
    return syntax, schema_ok, tool, arguments, kind


class Phase4Evaluator(Evaluator):
    def generate_ex(
        self,
        prompt: str,
        *,
        constrained: bool = False,
        oracle_tool: str | None = None,
        force_tool_prefix: bool = False,
        condition_on_tool_head: bool = True,
        temperature: float = 0.0,
    ) -> tuple[str, dict]:
        import torch

        ids = self._encoder_ids(prompt)
        plan = self.model.plan(ids)
        bias = on_token = None
        if constrained:
            bias, on_token, _ = make_constrained_bias(self.tok)
        prefix: list[int] = []
        oracle_id = _tool_id(oracle_tool) if oracle_tool and oracle_tool != "none" else None
        if force_tool_prefix:
            tool_name = oracle_tool if oracle_tool else plan["primary_tool"]
            out_type = "SEARCH_REQUEST" if tool_name == "web_search" else "TOOL_CALL"
            if tool_name and tool_name != "none":
                prefix = self.tok.encode(f'{{"type":"{out_type}","tool":"{tool_name}","arguments":')
        out = self.model.generate(
            ids,
            max_new_tokens=self.max_new,
            temperature=temperature,
            eos_id=self.tok.eos_id,
            start_token_id=self.assistant_id,
            forced_prefix_ids=prefix,
            logit_bias=bias,
            on_token=on_token,
            oracle_tool_id=oracle_id,
            condition_on_tool_head=condition_on_tool_head,
        )
        text = self.tok.decode(out[0].tolist(), skip_special=True).strip()
        return text, plan


def _score_split(ev: Phase4Evaluator, rows: list[dict], label: str, generate: bool) -> dict:
    head_pairs: list[tuple[str, str]] = []
    gen_pairs: list[tuple[str, str]] = []
    oracle_arg_hits = 0
    oracle_json = 0
    oracle_schema = 0
    oracle_n = 0
    gen_json = 0
    gen_schema = 0
    arg_hits = 0
    arg_n = 0
    top3_hits = 0
    details = []
    pred_counts: Counter = Counter()
    gold_counts: Counter = Counter()
    started = time.monotonic()

    for row in rows:
        prompt = row["prompt"]
        expected = row.get("tool") or row.get("expected_tool") or "none"
        expected_args = row.get("arguments")
        gold_counts[expected] += 1
        plan = ev.plan(prompt)
        head_tool = plan.get("primary_tool") or "none"
        top3 = [t["tool"] for t in plan.get("tool_head_top3") or []]
        head_pairs.append((expected, head_tool))
        top3_hits += int(expected in top3 or (expected == "none" and "none" in top3))

        record = {
            "prompt": prompt,
            "expected_tool": expected,
            "predicted_tool_head": head_tool,
            "predicted_tool_generated": None,
            "expected_arguments": expected_args if expected_args is not None else {},
            "predicted_arguments": {},
            "tool_head_top3": plan.get("tool_head_top3") or [],
            "tool_confidence": plan.get("tool_confidence"),
            "json_valid": None,
            "schema_valid": None,
            "workflow_success": False,
            "head_hit": head_tool == expected,
            "top3_hit": expected in top3,
        }

        if generate:
            text, _ = ev.generate_ex(prompt, constrained=False, condition_on_tool_head=True, temperature=0.0)
            syntax, schema_ok, gen_tool, gen_args, kind = _extract(text)
            gen_tool = gen_tool or "none"
            gen_pairs.append((expected, gen_tool))
            pred_counts[gen_tool] += 1
            gen_json += int(syntax)
            gen_schema += int(schema_ok)
            record["predicted_tool_generated"] = gen_tool
            record["predicted_arguments"] = gen_args or {}
            record["json_valid"] = syntax
            record["schema_valid"] = schema_ok
            record["generated_text"] = text[:400]
            record["generated_type"] = kind
            if expected_args is not None:
                arg_n += 1
                arg_hits += int(gen_tool == expected and args_match(expected, expected_args, gen_args))
            record["workflow_success"] = bool(
                syntax and schema_ok and gen_tool == expected and args_match(expected, expected_args, gen_args)
            )

            if expected != "none":
                oracle_n += 1
                otext, _ = ev.generate_ex(
                    prompt,
                    constrained=False,
                    oracle_tool=expected,
                    force_tool_prefix=True,
                    condition_on_tool_head=True,
                    temperature=0.0,
                )
                osyntax, oschema, otool, oargs, _ = _extract(otext)
                oracle_json += int(osyntax)
                oracle_schema += int(oschema)
                oracle_arg_hits += int(args_match(expected, expected_args or {}, oargs))
                record["oracle_tool"] = otool
                record["oracle_arguments"] = oargs or {}
                record["oracle_json_valid"] = osyntax
                record["oracle_schema_valid"] = oschema
                record["oracle_args_hit"] = args_match(expected, expected_args or {}, oargs)
        details.append(record)

    n = len(rows) or 1
    head_scores = per_tool_scores(head_pairs)
    head_agg = aggregate_scores(head_scores, head_pairs)
    gen_scores = per_tool_scores(gen_pairs) if gen_pairs else {}
    gen_agg = aggregate_scores(gen_scores, gen_pairs) if gen_pairs else {}
    top_tool, collapse = mode_collapse_share(pred_counts if pred_counts else Counter(p for _, p in head_pairs))
    collapse_source = pred_counts if pred_counts else Counter(p for _, p in head_pairs)
    result = {
        "label": label,
        "cases": len(rows),
        "wall_time_sec": round(time.monotonic() - started, 1),
        "tool_head": {
            "top1": head_agg["micro_accuracy"],
            "top3": round(top3_hits / n, 4),
            "macro_f1": head_agg["macro_f1"],
            "macro_accuracy": head_agg["macro_accuracy"],
            "weighted_f1": head_agg["weighted_f1"],
            "per_tool": head_scores,
            "confusion": confusion(head_pairs),
        },
        "generated": None,
        "oracle": None,
        "mode_collapse": {
            "top_tool": top_tool,
            "share": collapse,
            "entropy": prediction_entropy(collapse_source, len(TOOL_NAMES)),
            "uniform_entropy": expected_entropy(len(TOOL_NAMES)),
            "kl_to_expected": kl_divergence(collapse_source, gold_counts),
            "predicted_freq": dict(collapse_source.most_common()),
            "expected_freq": dict(gold_counts),
        },
        "cases_detail": details,
    }
    if generate:
        result["generated"] = {
            "tool_name_accuracy": gen_agg.get("micro_accuracy", 0.0),
            "macro_f1": gen_agg.get("macro_f1", 0.0),
            "json_syntax": round(gen_json / n, 4),
            "schema_valid": round(gen_schema / n, 4),
            "argument_accuracy": round(arg_hits / arg_n, 4) if arg_n else None,
            "argument_n": arg_n,
            "workflow_success": round(sum(1 for d in details if d.get("workflow_success")) / n, 4),
            "per_tool": gen_scores,
            "confusion": confusion(gen_pairs),
        }
        result["oracle"] = {
            "n": oracle_n,
            "json_syntax": round(oracle_json / oracle_n, 4) if oracle_n else None,
            "schema_valid": round(oracle_schema / oracle_n, 4) if oracle_n else None,
            "argument_accuracy": round(oracle_arg_hits / oracle_n, 4) if oracle_n else None,
        }
    return result


def _workflow_mocked() -> dict:
    """Orchestrator contract (mocked tools). Not language quality."""
    import asyncio
    from hrm.orchestration.workflow import HRMWorkflow

    class Scripted:
        def __init__(self, plan, text):
            self._plan = plan
            self._text = text

        def plan_text(self, text):
            return self._plan

        def generate_text(self, **kwargs):
            return self._text

    db = {
        "get_attendance": {"success": True, "percentage": 82, "present": 41, "absent": 9},
        "get_quiz_results": {"success": True, "attempts": [{"subject": "Physics", "score": 74}]},
        "web_search": {"success": True, "results": [{"title": "AI", "url": "https://example.edu/ai", "snippet": "open model"}]},
        "retrieve_learning_materials": {
            "success": True,
            "results": [{"source_id": "s1", "section": "Unit 3", "content": "Kinematics."}],
        },
        "get_exams": {"success": True, "exams": [{"subject": "Physics", "date": "2026-09-20"}]},
        "get_progress": {"success": True, "weakTopics": ["Trees"]},
        "get_goals": {"success": True, "goals": [{"title": "Pass"}]},
        "get_syllabus": {"success": True, "units": [{"name": "Unit 3"}]},
        "get_ar_lessons": {"success": True, "lessons": [{"topic": "CPU"}]},
        "get_learning_materials": {"success": True, "files": [{"title": "Trees.pdf"}]},
    }

    async def run_one(prompt, plan, completion, must_tools):
        async def execute(name, args):
            assert "userId" not in args and "sql" not in args
            return db.get(name, {"success": False, "error": "unknown"})

        wf = HRMWorkflow(Scripted(plan, completion), max_tool_steps=8)
        result = await wf.run(prompt, execute_tool=execute)
        used = [t["tool"] for t in result.get("toolResults") or []]
        ok = result.get("success") and all(t in used for t in must_tools)
        return {"prompt": prompt, "ok": bool(ok), "type": result.get("type"), "tools": used}

    cases = [
        (
            "What is my attendance?",
            {"task_type": "DB_QUERY", "primary_tool": "get_attendance", "tools": ["get_attendance"], "need_tools": True, "output_type": "FINAL_ANSWER"},
            json.dumps({"type": "FINAL_ANSWER", "answer": "Your attendance is 82%."}),
            ["get_attendance"],
        ),
        (
            "What are the latest developments in AI research this week?",
            {"task_type": "WEB_QUERY", "primary_tool": "web_search", "tools": ["web_search"], "need_tools": True, "output_type": "FINAL_ANSWER"},
            json.dumps({"type": "FINAL_ANSWER", "answer": "A new open model was released this week."}),
            ["web_search"],
        ),
        (
            "Make me a study plan based on my exams and weak subjects.",
            {
                "task_type": "STUDY_PLAN",
                "primary_tool": "get_exams",
                "tools": ["get_exams", "get_progress", "get_syllabus", "get_goals"],
                "need_tools": True,
                "output_type": "STUDY_PLAN",
            },
            json.dumps(
                {
                    "type": "STUDY_PLAN",
                    "title": "Exam week",
                    "schedule": [{"day": "Monday", "time": "18:00", "subject": "Physics", "topic": "Trees", "task": "Revise"}],
                }
            ),
            ["get_exams", "get_progress"],
        ),
    ]

    async def all_cases():
        out = []
        for prompt, plan, completion, must in cases:
            out.append(await run_one(prompt, plan, completion, must))
        return out

    results = asyncio.run(all_cases())
    return {
        "cases": len(results),
        "success": round(sum(1 for r in results if r["ok"]) / len(results), 4),
        "details": results,
        "note": "Mocked tool execution; measures orchestrator contract, not HRM language.",
    }


def main() -> dict:
    parser = argparse.ArgumentParser()
    parser.add_argument("--checkpoint", required=True)
    parser.add_argument("--benchmark", default=str(ROOT / "evaluation" / "tools" / "benchmark.jsonl"))
    parser.add_argument("--adversarial", default=str(ROOT / "evaluation" / "tools" / "adversarial.jsonl"))
    parser.add_argument("--max-new", type=int, default=96)
    parser.add_argument("--heads-only", action="store_true")
    parser.add_argument("--limit", type=int, default=0, help="optional cap on benchmark rows")
    parser.add_argument("--out", default=None)
    args = parser.parse_args()

    ev = Phase4Evaluator(Path(args.checkpoint), max_new=args.max_new)
    generate = not args.heads_only
    bench = _load_jsonl(Path(args.benchmark))
    if args.limit:
        bench = bench[: args.limit]
    adv = _load_jsonl(Path(args.adversarial))
    golden_rows = [{"prompt": g["prompt"], "tool": (g["tools"][0] if g["tools"] else "none"), "id": g["id"]} for g in GOLDEN_CASES]

    report = {
        "checkpoint": str(args.checkpoint),
        "tokenizer_version": ev.tok.version,
        "parameters": ev.model.parameter_count(),
        "temperature": 0.0,
        "top_k": None,
        "top_p": None,
        "max_tokens": args.max_new,
        "seed": 13,
        "date": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "heads_only": args.heads_only,
        "golden": _score_split(ev, golden_rows, "golden", generate),
        "benchmark": _score_split(ev, bench, "benchmark", generate),
        "adversarial": _score_split(ev, adv, "adversarial", generate) if adv else None,
        "workflow_mocked": _workflow_mocked(),
    }

    summary = {
        "tool_head_top1_bench": report["benchmark"]["tool_head"]["top1"],
        "tool_head_top3_bench": report["benchmark"]["tool_head"]["top3"],
        "tool_head_macro_f1_bench": report["benchmark"]["tool_head"]["macro_f1"],
        "generated_tool_bench": (report["benchmark"]["generated"] or {}).get("tool_name_accuracy"),
        "generated_json_bench": (report["benchmark"]["generated"] or {}).get("json_syntax"),
        "generated_schema_bench": (report["benchmark"]["generated"] or {}).get("schema_valid"),
        "argument_accuracy_bench": (report["benchmark"]["generated"] or {}).get("argument_accuracy"),
        "oracle_argument_accuracy": (report["benchmark"]["oracle"] or {}).get("argument_accuracy"),
        "golden_plan_tool": report["golden"]["tool_head"]["top1"],
        "mode_collapse_share": report["benchmark"]["mode_collapse"]["share"],
        "workflow_mocked_success": report["workflow_mocked"]["success"],
    }
    report["summary"] = summary
    print(json.dumps(summary, indent=2))
    if args.out:
        out_path = Path(args.out)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
        print("wrote", out_path)
    return report


if __name__ == "__main__":
    main()
