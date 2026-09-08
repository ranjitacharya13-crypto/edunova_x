#!/usr/bin/env python3
"""Structured-output evaluation for EduNova HRM checkpoints.

Measures, per mode (unconstrained / constrained):
- strict JSON syntax rate of generated text (json.loads on the raw decode)
- schema validity via hrm.outputs.parse_structured_output plus the quiz /
  study-plan / AR validators when the type matches
- tool-name accuracy against golden cases or the 117-case tool bench

Constrained decoding = byte-level JSON grammar filter: at every step the
only tokens allowed are those keeping the buffer a valid prefix of one
complete JSON value (<eos> is allowed only once the document is complete).
This is a real prefix-state machine over bytes, not a post-hoc repair.

    python evaluation/structured_output/eval_structured.py \
        --checkpoint post_training/checkpoints/edunova-hrm-20m-sft --golden \
        --benchmark evaluation/tools/benchmark.jsonl --out docs/results/hrm-sft-eval.json
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "ai_engine"))
sys.path.insert(0, str(ROOT / "evaluation"))

from golden import GOLDEN_CASES  # noqa: E402
from hrm.outputs import StructuredOutputError, parse_structured_output  # noqa: E402

WS = {32, 9, 10, 13}
ESCAPES = set(b'"\\/bfnrtu')
DIGITS = set(b"0123456789")


class JsonPrefixFsm:
    """Byte-level prefix validator for exactly one complete JSON value."""

    def __init__(self):
        # frames: ('obj', stage) stage in key|colon|value|comma ; ('arr', stage) stage in value|comma
        self.stack: list[tuple[str, str]] = []
        self.started = False      # top-level value begun
        self.complete = False     # top-level value finished
        self.in_string = False
        self.string_role = None   # 'key' | 'value'
        self.escape = False
        self.literal = None       # remaining bytes of true/false/null
        self.number = None        # sub-state: int|frac|exp
        self.failed = False

    def clone(self) -> "JsonPrefixFsm":
        other = JsonPrefixFsm()
        other.stack = list(self.stack)
        other.started = self.started
        other.complete = self.complete
        other.in_string = self.in_string
        other.string_role = self.string_role
        other.escape = self.escape
        other.literal = self.literal
        other.number = self.number
        other.failed = self.failed
        return other

    def _expecting_value(self) -> bool:
        if not self.started:
            return True
        if not self.stack:
            return False
        kind, stage = self.stack[-1]
        if stage == "value":
            return True
        return kind == "arr" and stage == "first"

    def _value_done(self) -> None:
        if not self.stack:
            self.complete = True
            return
        kind, _ = self.stack[-1]
        self.stack[-1] = (kind, "comma")

    def feed(self, b: int) -> bool:
        """Try one byte; returns False if it cannot extend a valid JSON prefix."""
        if self.failed:
            return False
        if self.in_string:
            if self.escape:
                if b in ESCAPES or b == ord("u"):
                    self.escape = False
                    return True
                self.failed = True
                return False
            if b == 0x5C:  # backslash
                self.escape = True
                return True
            if b == 0x22:  # closing quote
                self.in_string = False
                if self.string_role == "key":
                    self.stack[-1] = ("obj", "colon")
                else:
                    self._value_done()
                return True
            if b < 0x20:  # control bytes are illegal inside JSON strings
                self.failed = True
                return False
            return True
        if self.literal is not None:
            if b == self.literal[0]:
                self.literal = self.literal[1:]
                if not self.literal:
                    self.literal = None
                    self._value_done()
                return True
            self.failed = True
            return False
        if self.number is not None:
            if b in DIGITS:
                return True
            if self.number == "int" and b == ord("."):
                self.number = "frac"
                return True
            if self.number in ("int", "frac") and b in (ord("e"), ord("E")):
                self.number = "exp"
                return True
            if self.number == "exp" and b in (ord("+"), ord("-")):
                self.number = "exp_digits"
                return True
            # number terminates; fall through to structural handling
            self.number = None
            self._value_done()
        if self.complete:
            if b in WS:
                return True
            self.failed = True
            return False
        if b in WS:
            return True
        if not self.stack and self.started and not self.complete:
            self.failed = True
            return False
        frame = self.stack[-1] if self.stack else None
        stage = frame[1] if frame else ("value" if self._expecting_value() else None)
        if b == ord(":"):
            if frame and frame[0] == "obj" and stage == "colon":
                self.stack[-1] = ("obj", "value")
                return True
            self.failed = True
            return False
        if b == ord(","):
            if frame and stage == "comma":
                self.stack[-1] = (frame[0], "key" if frame[0] == "obj" else "value")
                return True
            self.failed = True
            return False
        if b in (ord("}"), ord("]")):
            want = "obj" if b == ord("}") else "arr"
            if frame and frame[0] == want and stage in ("first", "comma"):
                self.stack.pop()
                self._value_done()
                return True
            self.failed = True
            return False
        if b == 0x22:  # string: object key or value
            if frame and frame[0] == "obj" and stage in ("first", "key"):
                self.started = True
                self.in_string = True
                self.string_role = "key"
                return True
            if not self._expecting_value():
                self.failed = True
                return False
            self.started = True
            self.in_string = True
            self.string_role = "value"
            return True
        # remaining bytes can only start a value
        if not self._expecting_value():
            self.failed = True
            return False
        if b == ord("{"):
            self.started = True
            self.stack.append(("obj", "first"))
            return True
        if b == ord("["):
            self.started = True
            self.stack.append(("arr", "first"))
            return True
        if b == ord("-") or b in DIGITS:
            self.started = True
            self.number = "int"
            return True
        for lit, ch in ((b"rue", ord("t")), (b"alse", ord("f")), (b"ull", ord("n"))):
            if b == ch:
                self.started = True
                self.literal = lit
                return True
        self.failed = True
        return False

    def feed_bytes(self, data: bytes) -> bool:
        for b in data:
            if not self.feed(b):
                return False
        return True

    @property
    def accepts_eos(self) -> bool:
        return self.complete and not self.failed


def _valid_continuation_ids(tokenizer, fsm: JsonPrefixFsm, ids: list[int]) -> list[int]:
    ok = []
    special = {tokenizer.pad_id, tokenizer.bos_id, tokenizer.unk_id}
    for tid in ids:
        if tid in special:
            continue
        if tid == tokenizer.eos_id:
            if fsm.accepts_eos:
                ok.append(tid)
            continue
        text = tokenizer.id_to_token.get(int(tid))
        if text is None or text.startswith("<"):
            continue
        trial = fsm.clone()
        if trial.feed_bytes(text.encode("latin-1")):
            ok.append(tid)
    return ok


def make_constrained_bias(tokenizer, top_k: int = 96):
    """Returns (logit_bias(step, logits)->bias, state) for generate()."""
    import torch

    state = {"fsm": JsonPrefixFsm()}
    vocab = tokenizer.vocab_size
    sort_cache: list[int] = list(range(vocab))

    def on_token(token_id: int) -> None:
        if token_id == tokenizer.eos_id:
            return
        text = tokenizer.id_to_token.get(int(token_id), "")
        if not text.startswith("<"):
            state["fsm"].feed_bytes(text.encode("latin-1"))

    def bias(step: int, logits):
        k = min(top_k, logits.size(-1))
        top = torch.topk(logits[0].float(), k=k).indices.tolist()
        allowed = _valid_continuation_ids(tokenizer, state["fsm"], top)
        if not allowed:
            allowed = _valid_continuation_ids(tokenizer, state["fsm"], sort_cache)
        if not allowed:
            return None  # give up rather than force garbage; case will fail closed
        bias_tensor = torch.full((logits.size(-1),), -1e4, dtype=logits.dtype, device=logits.device)
        allowed_idx = torch.tensor(sorted(set(allowed)), dtype=torch.long, device=logits.device)
        bias_tensor[allowed_idx] = 0.0
        return bias_tensor

    return bias, on_token, state


def strict_json_ok(text: str) -> bool:
    try:
        json.loads(text)
        return True
    except (json.JSONDecodeError, TypeError):
        return False


def schema_check(text: str) -> tuple[bool, str, str | None]:
    """Returns (ok, type, tool). Uses the real backend validators."""
    try:
        out = parse_structured_output(text)
    except StructuredOutputError:
        return False, "", None
    kind, payload = out.type, out.payload
    try:
        if kind == "QUIZ":
            from hrm.orchestration.validators import validate_quiz

            validate_quiz(payload)
        elif kind == "STUDY_PLAN":
            from hrm.orchestration.validators import validate_study_plan

            validate_study_plan(payload)
        elif kind == "AR_SCENE":
            from hrm.orchestration.validators import validate_ar_scene

            validate_ar_scene(payload)
    except Exception:
        return False, kind, payload.get("tool")
    return True, kind, payload.get("tool")


class Evaluator:
    def __init__(self, checkpoint: Path, max_new: int = 192, guided: bool = False):
        import torch  # noqa: F401
        from hrm.hrm import EduNovaHRM
        from hrm.tokenizer import EduNovaTokenizer

        self.tok = EduNovaTokenizer.load(checkpoint)
        self.model = EduNovaHRM.from_pretrained(checkpoint)
        self.max_new = max_new
        self.guided = guided
        self.assistant_id = self.tok.token_to_id["<assistant>"]

    def _encoder_ids(self, prompt: str):
        import torch

        ids = self.tok.prompt_ids("You are EduNova HRM.", prompt)[: self.model.config.max_seq_len]
        return torch.tensor([ids], dtype=torch.long)

    def _wrapper_prefix(self, output_type: str) -> list[int]:
        return self.tok.encode('{"type":"' + output_type + '"')

    def generate(self, prompt: str, mode: str) -> tuple[str, list[int]]:
        import torch

        ids = self._encoder_ids(prompt)
        bias = on_token = None
        if mode == "constrained":
            bias, on_token, _ = make_constrained_bias(self.tok)
        prefix: list[int] = []
        if self.guided:
            plan = self.model.plan(ids)
            prefix = self._wrapper_prefix(plan["output_type"])
        out = self.model.generate(
            ids,
            max_new_tokens=self.max_new,
            temperature=0.0,
            eos_id=self.tok.eos_id,
            start_token_id=self.assistant_id,
            forced_prefix_ids=prefix,
            logit_bias=bias,
            on_token=on_token,
        )
        ids_out = out[0].tolist()
        text = self.tok.decode(ids_out, skip_special=True).strip()
        return text, ids_out

    def plan(self, prompt: str) -> dict:
        return self.model.plan(self._encoder_ids(prompt))


def run_golden(ev: Evaluator, modes: list[str]) -> dict:
    cases = []
    agg: dict[str, list] = {m: {"json": [], "schema": []} for m in modes}
    plan_tool_hits = plan_task_hits = 0
    started = time.monotonic()
    for case in GOLDEN_CASES:
        prompt = case["prompt"]
        plan = ev.plan(prompt)
        tool_hit = plan["primary_tool"] in case["tools"] or bool(set(plan["tools"]) & set(case["tools"]))
        task_hit = plan["task_type"] == case["task_type"]
        plan_tool_hits += int(tool_hit)
        plan_task_hits += int(task_hit)
        record = {"id": case["id"], "prompt": prompt, "plan": {k: plan[k] for k in ("task_type", "primary_tool", "tools", "output_type")}, "plan_tool_hit": tool_hit, "plan_task_hit": task_hit, "modes": {}}
        for mode in modes:
            text, _ = ev.generate(prompt, mode)
            syntax = strict_json_ok(text)
            schema_ok, kind, tool = schema_check(text)
            agg[mode]["json"].append(syntax)
            agg[mode]["schema"].append(schema_ok)
            record["modes"][mode] = {"text": text[:400], "json_syntax": syntax, "schema_ok": schema_ok, "type": kind, "tool": tool}
        cases.append(record)
    n = len(GOLDEN_CASES)
    summary = {
        "cases": n,
        "plan_tool_accuracy": round(plan_tool_hits / n, 4),
        "plan_task_accuracy": round(plan_task_hits / n, 4),
        "wall_time_sec": round(time.monotonic() - started, 1),
    }
    for mode in modes:
        summary[f"json_syntax_{mode}"] = round(sum(agg[mode]["json"]) / n, 4)
        summary[f"schema_{mode}"] = round(sum(agg[mode]["schema"]) / n, 4)
    return {"summary": summary, "cases": cases}


def run_benchmark(ev: Evaluator, bench_path: Path, modes: list[str]) -> dict:
    rows = [json.loads(l) for l in bench_path.read_text(encoding="utf-8").splitlines() if l.strip()]
    details = []
    agg: dict[str, dict[str, list]] = {m: {"json": [], "tool": []} for m in modes}
    predicted_tools: dict[str, Counter] = {m: Counter() for m in modes}
    started = time.monotonic()
    for row in rows:
        record = {"id": row["id"], "prompt": row["prompt"], "expected_tool": row["tool"], "modes": {}}
        for mode in modes:
            text, _ = ev.generate(row["prompt"], mode)
            syntax = strict_json_ok(text)
            _, kind, tool = schema_check(text)
            hit = tool == row["tool"]
            agg[mode]["json"].append(syntax)
            agg[mode]["tool"].append(hit)
            predicted_tools[mode][tool or "<none>"] += 1
            record["modes"][mode] = {"json_syntax": syntax, "type": kind, "tool": tool, "tool_hit": hit, "text": text[:300]}
        details.append(record)
    n = len(rows)
    summary = {"cases": n, "wall_time_sec": round(time.monotonic() - started, 1)}
    for mode in modes:
        summary[f"json_syntax_{mode}"] = round(sum(agg[mode]["json"]) / n, 4)
        summary[f"tool_name_accuracy_{mode}"] = round(sum(agg[mode]["tool"]) / n, 4)
        summary[f"predicted_tool_top3_{mode}"] = predicted_tools[mode].most_common(3)
    return {"summary": summary, "cases": details}


def main() -> dict:
    parser = argparse.ArgumentParser()
    parser.add_argument("--checkpoint", required=True)
    parser.add_argument("--golden", action="store_true")
    parser.add_argument("--benchmark", default=None)
    parser.add_argument("--mode", choices=["both", "constrained", "unconstrained"], default="both")
    parser.add_argument("--guided", action="store_true", help="force first tokens to the wrapper of the model's own output-type head")
    parser.add_argument("--max-new", type=int, default=192)
    parser.add_argument("--out", default=None)
    args = parser.parse_args()

    modes = ["constrained", "unconstrained"] if args.mode == "both" else [args.mode]
    ev = Evaluator(Path(args.checkpoint), max_new=args.max_new, guided=args.guided)
    result: dict = {
        "checkpoint": str(args.checkpoint),
        "tokenizer_version": ev.tok.version,
        "parameters": ev.model.parameter_count(),
        "guided_wrapper": args.guided,
        "modes": modes,
        "date": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    if args.golden:
        result["golden"] = run_golden(ev, modes)
        print("GOLDEN", json.dumps(result["golden"]["summary"], indent=2))
    if args.benchmark:
        result["benchmark"] = run_benchmark(ev, Path(args.benchmark), modes)
        print("BENCH", json.dumps(result["benchmark"]["summary"], indent=2))
    if args.out:
        out_path = Path(args.out)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(json.dumps(result, indent=2, ensure_ascii=False), encoding="utf-8")
        print("wrote", out_path)
    return result


if __name__ == "__main__":
    main()
