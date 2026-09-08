"""Build evaluation/tools/benchmark.jsonl — eval-only tool-routing bench.

One prompt = one expected primary tool. Phrasings are deliberately disjoint
from the SFT dataset and from the golden suite; the builder asserts that.
Never train on this file.
"""

from __future__ import annotations

import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "evaluation"))
from golden import GOLDEN_CASES  # noqa: E402

OUT = Path(__file__).resolve().parent / "benchmark.jsonl"
SFT_DIR = ROOT / "post_training" / "datasets" / "sft"

CASES: list[tuple[str, str]] = [
    # get_attendance
    ("How many lectures did I bunk last month?", "get_attendance"),
    ("Am I above the attendance cutoff?", "get_attendance"),
    ("Give me my attendance numbers.", "get_attendance"),
    ("What fraction of classes have I attended?", "get_attendance"),
    # get_student_profile
    ("Which batch do I belong to?", "get_student_profile"),
    ("Show me my enrollment info.", "get_student_profile"),
    ("What class am I studying in?", "get_student_profile"),
    ("Check my profile on EduNova.", "get_student_profile"),
    # get_subjects
    ("What am I studying this semester?", "get_subjects"),
    ("Name my enrolled subjects.", "get_subjects"),
    ("Which subjects are on my registration?", "get_subjects"),
    ("How many subjects do I have?", "get_subjects"),
    # get_timetable
    ("What's my schedule on Thursday?", "get_timetable"),
    ("Display the week view of my classes.", "get_timetable"),
    ("Show Saturday's class grid.", "get_timetable"),
    ("Read out my weekly lecture plan.", "get_timetable"),
    # get_today_schedule
    ("Any classes left today?", "get_today_schedule"),
    ("What's happening in school today?", "get_today_schedule"),
    ("Give me this day's schedule.", "get_today_schedule"),
    ("Which lectures are lined up for today?", "get_today_schedule"),
    # get_upcoming_classes
    ("What lecture do I have after this one?", "get_upcoming_classes"),
    ("Show the classes starting later today.", "get_upcoming_classes"),
    ("When is my next chemistry lecture?", "get_upcoming_classes"),
    ("Which period comes after the break?", "get_upcoming_classes"),
    # get_syllabus
    ("What chapters are in the math book?", "get_syllabus"),
    ("Show the course outline for history.", "get_syllabus"),
    ("List units from my physics curriculum.", "get_syllabus"),
    ("Which topics are included in the biology course?", "get_syllabus"),
    # get_learning_materials
    ("Open my uploaded file on trigonometry.", "get_learning_materials"),
    ("Show the document I uploaded about volcanoes.", "get_learning_materials"),
    ("Find uploaded revision notes for English.", "get_learning_materials"),
    ("Get the PDF I added for chemical equations.", "get_learning_materials"),
    # get_progress
    ("Am I getting better at physics?", "get_progress"),
    ("Where do I stand in my courses?", "get_progress"),
    ("Show how I'm performing overall.", "get_progress"),
    ("Which subjects need more work from me?", "get_progress"),
    # get_study_history
    ("How long did I study last night?", "get_study_history"),
    ("Show sessions from the past week.", "get_study_history"),
    ("When did I last open chemistry notes?", "get_study_history"),
    ("What have I studied recently?", "get_study_history"),
    # get_quiz_history
    ("List quizzes I attempted in May.", "get_quiz_history"),
    ("Which tests have I completed?", "get_quiz_history"),
    ("Show quiz attempts for biology.", "get_quiz_history"),
    ("Have I practiced any math quizzes?", "get_quiz_history"),
    # get_quiz_results
    ("Did I pass the last physics test?", "get_quiz_results"),
    ("Show scores from my recent quizzes.", "get_quiz_results"),
    ("What percentage did I get in the math quiz?", "get_quiz_results"),
    ("Give me the results of my quiz attempts.", "get_quiz_results"),
    # get_assignments
    ("What homework is pending submission?", "get_assignments"),
    ("Show assignments with deadlines this week.", "get_assignments"),
    ("Do I need to submit anything tomorrow?", "get_assignments"),
    ("List unfinished assignments.", "get_assignments"),
    # get_exams
    ("What exams do I have in December?", "get_exams"),
    ("Tell me when my biology test is.", "get_exams"),
    ("Are board exams scheduled yet?", "get_exams"),
    ("List my test dates.", "get_exams"),
    # get_attendance variant phrasing
    ("How is my presence record this term?", "get_attendance"),
    # get_notes
    ("Open notes I saved for algebra.", "get_notes"),
    ("Do I have notes on the French Revolution?", "get_notes"),
    ("Show my saved short notes.", "get_notes"),
    ("Find my chemistry revision notes.", "get_notes"),
    # get_goals
    ("What targets am I working toward?", "get_goals"),
    ("Show my goal list.", "get_goals"),
    ("Remind me what I aimed to finish this month.", "get_goals"),
    ("Which goals are still open?", "get_goals"),
    # get_upcoming_events
    ("Is the science fair coming up?", "get_upcoming_events"),
    ("What events are on the school calendar?", "get_upcoming_events"),
    ("Show functions happening next month.", "get_upcoming_events"),
    ("Any seminars I should attend soon?", "get_upcoming_events"),
    # get_notifications
    ("Read my new messages from school.", "get_notifications"),
    ("Any updates in my inbox?", "get_notifications"),
    ("Show teacher announcements for this week.", "get_notifications"),
    ("What did I get notified about today?", "get_notifications"),
    # retrieve_learning_materials
    ("Find explanations of entropy in my materials.", "retrieve_learning_materials"),
    ("Search study content for Ohm's law.", "retrieve_learning_materials"),
    ("Retrieve learning content on plate tectonics.", "retrieve_learning_materials"),
    ("Look up material about integration by parts.", "retrieve_learning_materials"),
    # web_search
    ("Search current events in AI policy.", "web_search"),
    ("Find news about recent Mars missions online.", "web_search"),
    ("Look up this week's Nobel announcements.", "web_search"),
    ("Search the internet for new vaccine research.", "web_search"),
    # open_url
    ("Open https://example.edu/geo/latitude.", "open_url"),
    ("Visit https://example.edu/cs/recursion page.", "open_url"),
    ("Open the link https://example.edu/news/exam-dates.", "open_url"),
    ("Load https://example.edu/bio/ecosystems.", "open_url"),
    # extract_webpage
    ("Extract text from https://example.edu/math/vectors.", "extract_webpage"),
    ("Scrape https://example.edu/chem/acids-bases.", "extract_webpage"),
    ("Read and extract https://example.edu/history/ww2 summary.", "extract_webpage"),
    ("Pull main content from https://example.edu/physics/optics.", "extract_webpage"),
    # calculator
    ("What is 55 times 19?", "calculator"),
    ("Compute 1000 divided by 8.", "calculator"),
    ("Evaluate (12 + 8) squared.", "calculator"),
    ("How much is 20 percent of 450?", "calculator"),
    # get_current_datetime
    ("What's the date today?", "get_current_datetime"),
    ("Current time please.", "get_current_datetime"),
    ("Which month is it?", "get_current_datetime"),
    ("Tell me the day today.", "get_current_datetime"),
    # get_ar_lessons
    ("Show AR content for the human skeleton.", "get_ar_lessons"),
    ("Is there an AR lesson on electric motors?", "get_ar_lessons"),
    ("Find an AR model of a plant cell.", "get_ar_lessons"),
    ("Look for AR lessons about the solar system.", "get_ar_lessons"),
    # create_quiz
    ("Build a practice test on trigonometric ratios.", "create_quiz"),
    ("Make questions on cellular respiration.", "create_quiz"),
    ("Set a quiz about World War 2.", "create_quiz"),
    ("Prepare practice questions on sorting algorithms.", "create_quiz"),
    # save_quiz
    ("Keep this geography quiz saved.", "save_quiz"),
    ("Store the motion quiz in my library.", "save_quiz"),
    ("Save my fractions practice test.", "save_quiz"),
    ("Save this data structures quiz for revision.", "save_quiz"),
    # create_study_plan
    ("Draft a prep schedule for my math final.", "create_study_plan"),
    ("Plan my studies for the chemistry unit test.", "create_study_plan"),
    ("Make a weekly schedule for biology revision.", "create_study_plan"),
    ("Organize my preparation for the history exam.", "create_study_plan"),
    # open_feature
    ("Jump to the timetable tab.", "open_feature"),
    ("Open the progress dashboard in the app.", "open_feature"),
    ("Switch to the AR section.", "open_feature"),
    ("Take me to the assignments screen.", "open_feature"),
]


def _norm(text: str) -> str:
    return " ".join(str(text).lower().split())


def _sft_prompts() -> set[str]:
    prompts: set[str] = set()
    for name in ("train.jsonl", "val.jsonl"):
        path = SFT_DIR / name
        if path.exists():
            for line in path.read_text(encoding="utf-8").splitlines():
                if line.strip():
                    prompts.add(_norm(json.loads(line)["prompt"]))
    return prompts


def main() -> None:
    golden = {_norm(g["prompt"]) for g in GOLDEN_CASES}
    sft = _sft_prompts()
    seen: set[str] = set()
    rows = []
    for i, (prompt, tool) in enumerate(CASES):
        key = _norm(prompt)
        assert key not in golden, f"benchmark prompt matches golden: {prompt!r}"
        assert key not in sft, f"benchmark prompt matches SFT data: {prompt!r}"
        assert key not in seen, f"duplicate benchmark prompt: {prompt!r}"
        seen.add(key)
        rows.append({"id": f"bench_{i:03d}", "prompt": prompt, "tool": tool})
    with OUT.open("w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")
    tools = sorted({r["tool"] for r in rows})
    print(f"wrote {len(rows)} cases to {OUT} covering {len(tools)} tools")


if __name__ == "__main__":
    main()
