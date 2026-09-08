"""Held-out adversarial routing set.

Phrasings are deliberately confusing (near-neighbour tools) and must never
appear in SFT. The builder asserts disjointness from golden, benchmark, and
SFT prompts. Never train on this file.
"""

from __future__ import annotations

import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "evaluation"))
from golden import GOLDEN_CASES  # noqa: E402

OUT = Path(__file__).resolve().parent / "adversarial.jsonl"
SFT_DIR = ROOT / "post_training" / "datasets" / "sft"
BENCH_PATH = Path(__file__).resolve().parent / "benchmark.jsonl"

# Completely held-out wording. Do not paraphrase these into SFT.
CASES: list[tuple[str, str, dict]] = [
    ("What classes do I have?", "get_today_schedule", {}),
    ("What classes do I have today?", "get_today_schedule", {}),
    ("What classes are coming up?", "get_upcoming_classes", {}),
    ("Show my timetable.", "get_timetable", {}),
    ("What subjects do I have?", "get_subjects", {}),
    ("How much attendance do I have?", "get_attendance", {}),
    ("How am I doing academically?", "get_progress", {}),
    ("Show my study history.", "get_study_history", {}),
    ("Show my quiz history.", "get_quiz_history", {}),
    ("Show my quiz results.", "get_quiz_results", {}),
    ("What did I study yesterday?", "get_study_history", {}),
    ("What were my previous quiz scores?", "get_quiz_results", {}),
    ("What is my timetable?", "get_timetable", {}),
    ("What classes do I have the day after today?", "get_upcoming_classes", {}),
    ("How much of class have I attended?", "get_attendance", {}),
    ("Show the notes I typed myself.", "get_notes", {}),
    ("Search the public internet for fusion news.", "web_search", {"query": "fusion news"}),
    ("Open my uploaded PDF, not the syllabus.", "get_learning_materials", {}),
    ("Don't list attempts — I want the marks.", "get_quiz_results", {}),
    ("Navigate to the timetable tab in the app.", "open_feature", {"view": "timetable"}),
    ("Compute 21 times 4.", "calculator", {"expression": "21*4"}),
    ("What time is it, not my classes.", "get_current_datetime", {}),
    ("School events, not lectures.", "get_upcoming_events", {}),
    ("Homework still due, not exams.", "get_assignments", {}),
    ("Official syllabus outline for chemistry.", "get_syllabus", {"subject": "Chemistry"}),
    ("Explain photosynthesis without looking anything up.", "none", {}),
    ("Create a quiz on gravity.", "create_quiz", {"subject": "Physics", "topic": "gravity"}),
    ("Save the gravity quiz I just made.", "save_quiz", {"topic": "gravity"}),
    ("Draft a study plan for my weak topics.", "create_study_plan", {}),
    ("Find an AR lesson on the heart.", "get_ar_lessons", {"topic": "heart"}),
]


def _norm(text: str) -> str:
    return " ".join(str(text).lower().split())


def _jsonl_prompts(path: Path) -> set[str]:
    if not path.exists():
        return set()
    out = set()
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip():
            out.add(_norm(json.loads(line)["prompt"]))
    return out


def _sft_prompts() -> set[str]:
    prompts: set[str] = set()
    for name in ("train.jsonl", "val.jsonl"):
        prompts |= _jsonl_prompts(SFT_DIR / name)
    return prompts


def main() -> None:
    golden = {_norm(g["prompt"]) for g in GOLDEN_CASES}
    sft = _sft_prompts()
    bench = _jsonl_prompts(BENCH_PATH)
    seen: set[str] = set()
    rows = []
    for i, (prompt, tool, args) in enumerate(CASES):
        key = _norm(prompt)
        assert key not in golden, f"adversarial matches golden: {prompt!r}"
        assert key not in sft, f"adversarial matches SFT: {prompt!r}"
        assert key not in bench, f"adversarial matches benchmark: {prompt!r}"
        assert key not in seen, f"duplicate adversarial prompt: {prompt!r}"
        seen.add(key)
        row = {"id": f"adv_{i:03d}", "prompt": prompt, "tool": tool, "arguments": args}
        rows.append(row)
    with OUT.open("w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")
    print(f"wrote {len(rows)} adversarial cases to {OUT}")


if __name__ == "__main__":
    main()
