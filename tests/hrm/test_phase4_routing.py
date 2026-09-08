"""Phase 4 routing / data / metric tests. No fake scores, no keyword router."""

from __future__ import annotations

import ast
import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "ai_engine"))
sys.path.insert(0, str(ROOT / "training"))
sys.path.insert(0, str(ROOT / "evaluation"))
sys.path.insert(0, str(ROOT / "post_training"))

from hrm.config import TOOL_NAMES  # noqa: E402
from hrm.tokenizer import EduNovaTokenizer  # noqa: E402
from hrm.tokenizer.specials import TOOL_TOKENS  # noqa: E402
from metrics import args_match, canonical_args, confusion, per_tool_scores, aggregate_scores  # noqa: E402

try:
    import torch  # noqa: F401

    TORCH = True
except Exception:
    TORCH = False


def _norm(text: str) -> str:
    return " ".join(str(text).lower().split())


def _jsonl(path: Path) -> list[dict]:
    if not path.exists():
        return []
    return [json.loads(l) for l in path.read_text(encoding="utf-8").splitlines() if l.strip()]


class TokenizerAtomicTools(unittest.TestCase):
    def test_every_allowlisted_tool_is_atomic(self):
        tok = EduNovaTokenizer()
        missing = [t for t in TOOL_NAMES if t != "none" and t not in tok.token_to_id]
        self.assertEqual(missing, [], f"tools missing from tokenizer vocab: {missing}")
        for name in TOOL_TOKENS:
            ids = tok.encode(name)
            self.assertEqual(len(ids), 1, f"{name} split into {ids} ({[tok.id_to_token[i] for i in ids]})")

    def test_json_wrappers_atomic(self):
        tok = EduNovaTokenizer()
        text = '{"type":"TOOL_CALL","tool":"get_attendance","arguments":{}}'
        ids = tok.encode(text)
        self.assertLessEqual(len(ids), 10, f"JSON should be compact, got {len(ids)} tokens")


class NoKeywordRouter(unittest.TestCase):
    """The HRM must learn routing. A keyword if-ladder is a cheating router."""

    FORBIDDEN_SUBSTRINGS = (
        'if "attendance" in',
        "if 'attendance' in",
        'if "timetable" in',
        'if "quiz" in prompt',
    )

    def test_router_and_planner_have_no_keyword_ladder(self):
        files = [
            ROOT / "ai_engine" / "hrm" / "orchestration" / "tool_router.py",
            ROOT / "ai_engine" / "hrm" / "orchestration" / "planner.py",
            ROOT / "ai_engine" / "hrm" / "inference" / "runtime.py",
        ]
        for path in files:
            src = path.read_text(encoding="utf-8")
            for needle in self.FORBIDDEN_SUBSTRINGS:
                self.assertNotIn(needle, src.lower() if needle.islower() else src, f"{path} contains {needle!r}")
            tree = ast.parse(src)
            for node in ast.walk(tree):
                if isinstance(node, ast.Compare):
                    # flag `if "attendance" in prompt`-style compares on a name called prompt
                    pass


class LeakageTests(unittest.TestCase):
    def test_sft_disjoint_from_eval_sets(self):
        from golden import GOLDEN_CASES

        sft_dir = ROOT / "post_training" / "datasets" / "sft"
        train = {_norm(r["prompt"]) for r in _jsonl(sft_dir / "train.jsonl")}
        val = {_norm(r["prompt"]) for r in _jsonl(sft_dir / "val.jsonl")}
        if not train:
            self.skipTest("SFT data not built")
        golden = {_norm(g["prompt"]) for g in GOLDEN_CASES}
        bench = {_norm(r["prompt"]) for r in _jsonl(ROOT / "evaluation" / "tools" / "benchmark.jsonl")}
        adv = {_norm(r["prompt"]) for r in _jsonl(ROOT / "evaluation" / "tools" / "adversarial.jsonl")}
        self.assertEqual(train & val, set())
        self.assertEqual(train & golden, set())
        self.assertEqual(val & golden, set())
        self.assertEqual((train | val) & bench, set())
        self.assertEqual((train | val) & adv, set())
        self.assertEqual(bench & golden, set())
        self.assertEqual(adv & bench, set())
        self.assertEqual(adv & golden, set())

    def test_sft_has_at_least_500_rows_when_built(self):
        meta_path = ROOT / "post_training" / "datasets" / "sft" / "metadata.json"
        if not meta_path.exists():
            self.skipTest("SFT metadata missing")
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        self.assertGreaterEqual(meta["rows"]["total"], 500)
        self.assertEqual(meta.get("golden_overlap"), [])
        self.assertEqual(meta.get("benchmark_overlap"), [])


class ArgumentCanonicalization(unittest.TestCase):
    def test_calculator_whitespace(self):
        self.assertTrue(args_match("calculator", {"expression": "55 * 19"}, {"expression": "55*19"}))
        self.assertFalse(args_match("calculator", {"expression": "55*19"}, {"expression": "1+1"}))

    def test_empty_vs_extra(self):
        self.assertTrue(args_match("get_attendance", {}, {}))
        self.assertFalse(args_match("get_attendance", {}, {"subject": "Physics"}))
        self.assertTrue(args_match("get_attendance", None, {"subject": "Physics"}))

    def test_canonical_drops_empty(self):
        self.assertEqual(canonical_args("get_notes", {"subject": "", "query": None}), {})


class ConfusionMetrics(unittest.TestCase):
    def test_perfect_and_swap(self):
        pairs = [("a", "a"), ("a", "b"), ("b", "b"), ("b", "b")]
        table = confusion(pairs)
        self.assertEqual(table["a"]["a"], 1)
        self.assertEqual(table["a"]["b"], 1)
        scores = per_tool_scores(pairs, ["a", "b"])
        self.assertEqual(scores["b"]["true_positives"], 2)
        agg = aggregate_scores(scores, pairs)
        self.assertAlmostEqual(agg["micro_accuracy"], 0.75)


class CurriculumSamplerTests(unittest.TestCase):
    def test_unlocks_stages(self):
        sys.path.insert(0, str(ROOT / "post_training"))
        from train_sft import CurriculumSampler

        rows = [{"stage": 1, "tool_id": 1}, {"stage": 2, "tool_id": 2}, {"stage": 9, "tool_id": 3}]
        sampler = CurriculumSampler(rows, batch_size=4, seed=0)
        self.assertEqual(sampler.set_progress(0, 100), 1)
        self.assertEqual(sampler.set_progress(50, 100), 4)
        self.assertEqual(sampler.set_progress(99, 100), 9)
        picks = sampler.sample()
        self.assertEqual(len(picks), 4)


class SecurityOutputs(unittest.TestCase):
    def test_forbidden_args_still_rejected(self):
        from hrm.outputs import StructuredOutputError, parse_structured_output

        with self.assertRaises(StructuredOutputError):
            parse_structured_output('{"type":"TOOL_CALL","tool":"get_attendance","arguments":{"sql":"select 1"}}')
        with self.assertRaises(StructuredOutputError):
            parse_structured_output('{"type":"TOOL_CALL","tool":"get_attendance","arguments":{"userId":"abc"}}')
        with self.assertRaises(StructuredOutputError):
            parse_structured_output('{"type":"TOOL_CALL","tool":"web_search","arguments":{"token":"sekrit"}}')

    def test_unknown_tool_rejected(self):
        from hrm.outputs import StructuredOutputError, parse_structured_output

        with self.assertRaises(StructuredOutputError):
            parse_structured_output('{"type":"TOOL_CALL","tool":"drop_database","arguments":{}}')


class IdentityIsolation(unittest.IsolatedAsyncioTestCase):
    async def test_workflow_does_not_forward_userid(self):
        from hrm.orchestration.workflow import HRMWorkflow

        class Fake:
            def plan_text(self, text):
                return {
                    "task_type": "DB_QUERY",
                    "primary_tool": "get_attendance",
                    "tools": ["get_attendance"],
                    "need_tools": True,
                    "output_type": "FINAL_ANSWER",
                }

            def generate_text(self, **kwargs):
                return json.dumps({"type": "FINAL_ANSWER", "answer": "82%"})

        seen = []

        async def execute(name, args):
            seen.append(args)
            return {"success": True, "percentage": 82}

        wf = HRMWorkflow(Fake(), max_tool_steps=2)
        result = await wf.run("What is my attendance?", execute_tool=execute)
        self.assertTrue(result["success"])
        self.assertTrue(seen)
        for args in seen:
            self.assertNotIn("userId", args)
            self.assertNotIn("user_id", args)
            self.assertNotIn("sql", args)
            self.assertNotIn("token", args)


@unittest.skipUnless(TORCH, "torch not installed")
class ToolConditioningForward(unittest.TestCase):
    def test_tool_cond_changes_decoder_start(self):
        from hrm.config import HRMConfig
        from hrm.hrm import EduNovaHRM

        cfg = HRMConfig(
            name="tiny",
            vocab_size=64,
            d_model=32,
            n_heads=4,
            high_level_layers=1,
            low_level_layers=1,
            max_seq_len=16,
        )
        model = EduNovaHRM(cfg)
        self.assertTrue(hasattr(model.high, "tool_cond"))
        ids = torch.randint(0, 64, (2, 6))
        tool_a = torch.zeros(2, dtype=torch.long)
        tool_b = torch.ones(2, dtype=torch.long)
        out_a = model(ids, decoder_input_ids=ids, tool_ids=tool_a)
        out_b = model(ids, decoder_input_ids=ids, tool_ids=tool_b)
        self.assertEqual(out_a["logits"].shape, out_b["logits"].shape)
        self.assertFalse(torch.allclose(out_a["logits"], out_b["logits"]))
        plan = model.plan(ids[:1])
        self.assertIn("tool_head_top3", plan)
        self.assertEqual(len(plan["tool_head_top3"]), 3)
        gen = model.generate(ids[:1], max_new_tokens=3, temperature=0.0, oracle_tool_id=1)
        self.assertEqual(gen.dim(), 2)
        with tempfile.TemporaryDirectory() as tmp:
            model.save_pretrained(tmp)
            loaded = EduNovaHRM.from_pretrained(tmp)
            self.assertEqual(loaded.parameter_count(), model.parameter_count())


class LossMultitask(unittest.TestCase):
    def test_combine_weights(self):
        from loss import combine_multitask

        total = combine_multitask(1.0, 2.0, 0.0, 0.0, 0.0, lambda_tool=2.0, lambda_output=0.75, lambda_task=0.5, lambda_need=0.25)
        self.assertAlmostEqual(total, 1.0 + 4.0)


if __name__ == "__main__":
    unittest.main()
