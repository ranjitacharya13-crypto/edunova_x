"""End-to-end workflow tests with mocked EduNova tools (no student data)."""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "ai_engine"))

from hrm.orchestration.validators import validate_ar_scene, validate_quiz, validate_study_plan  # noqa: E402
from hrm.orchestration.workflow import HRMWorkflow  # noqa: E402


class ScriptedRuntime:
    def __init__(self, plan: dict, text: str):
        self._plan = plan
        self._text = text

    def plan_text(self, text):
        return self._plan

    def generate_text(self, **kwargs):
        return self._text


DB = {
    "get_attendance": {"success": True, "percentage": 88, "present": 22, "absent": 3},
    "get_upcoming_classes": {"success": True, "classes": [{"day": "Tuesday", "subject": "Physics", "time": "10:00"}]},
    "get_syllabus": {"success": True, "units": [{"name": "Unit 3", "topics": ["Kinematics"]}]},
    "retrieve_learning_materials": {"success": True, "results": [{"source_id": "syllabus_001", "section": "Unit 3", "content": "Kinematics studies motion without forces."}]},
    "web_search": {"success": True, "results": [{"title": "AI news", "url": "https://example.edu/ai", "snippet": "A new open model was released this week."}]},
    "get_exams": {"success": True, "exams": [{"subject": "Physics", "date": "2026-09-20"}]},
    "get_progress": {"success": True, "weakTopics": ["Trees"], "quizPerformance": [{"_id": "Data Structures", "averageScore": 42}]},
    "get_goals": {"success": True, "goals": [{"title": "Pass boards"}]},
    "get_quiz_results": {"success": True, "attempts": [{"subject": "Data Structures", "score": 40}]},
    "get_learning_materials": {"success": True, "files": [{"title": "Trees.pdf"}]},
    "get_ar_lessons": {"success": True, "lessons": [{"_id": "cpu1", "topic": "CPU Architecture"}]},
}


class WorkflowE2E(unittest.IsolatedAsyncioTestCase):
    async def _run(self, prompt, plan, completion):
        async def execute(name, args):
            self.assertNotIn("userId", args)
            self.assertNotIn("sql", args)
            if name not in DB:
                return {"success": False, "error": "unknown"}
            return DB[name]

        wf = HRMWorkflow(ScriptedRuntime(plan, completion), max_tool_steps=8)
        return await wf.run(prompt, execute_tool=execute)

    async def test_attendance_grounded(self):
        result = await self._run(
            "What is my attendance?",
            {"task_type": "DB_QUERY", "primary_tool": "get_attendance", "tools": ["get_attendance"], "need_tools": True, "output_type": "FINAL_ANSWER"},
            json.dumps({"type": "FINAL_ANSWER", "answer": "According to EduNova your attendance is 88%."}),
        )
        self.assertEqual(result["toolResults"][0]["tool"], "get_attendance")
        self.assertIn("88", result["message"])

    async def test_syllabus_rag(self):
        result = await self._run(
            "Explain Unit 3 from my syllabus.",
            {"task_type": "RAG_QUERY", "primary_tool": "retrieve_learning_materials", "tools": ["get_syllabus", "retrieve_learning_materials"], "need_tools": True, "output_type": "FINAL_ANSWER"},
            json.dumps({"type": "FINAL_ANSWER", "answer": "Unit 3 covers kinematics (retrieved)."}),
        )
        tools = [t["tool"] for t in result["toolResults"]]
        self.assertIn("retrieve_learning_materials", tools)

    async def test_web_uses_sources(self):
        result = await self._run(
            "What are the latest developments in AI research this week?",
            {"task_type": "WEB_QUERY", "primary_tool": "web_search", "tools": ["web_search"], "need_tools": True, "output_type": "FINAL_ANSWER"},
            json.dumps({"type": "FINAL_ANSWER", "answer": "A new open model was released this week [example.edu]."}),
        )
        self.assertTrue(any(s.get("source_type") == "web" for s in result["sources"]))

    async def test_quiz_validated(self):
        quiz = {
            "type": "QUIZ",
            "title": "Data Structures — Unit 2",
            "difficulty": "medium",
            "questions": [{"type": "mcq", "question": "LIFO?", "options": ["Queue", "Stack", "Heap", "Graph"], "answer": "Stack", "explanation": "Stack is LIFO"}],
        }
        validate_quiz(quiz)
        result = await self._run(
            "Create a 10-question medium quiz from Unit 2.",
            {"task_type": "QUIZ", "primary_tool": "retrieve_learning_materials", "tools": ["retrieve_learning_materials"], "need_tools": True, "output_type": "QUIZ"},
            json.dumps(quiz),
        )
        self.assertEqual(result["type"], "QUIZ")

    async def test_study_plan(self):
        plan = {
            "type": "STUDY_PLAN",
            "title": "Exam week",
            "schedule": [{"day": "Monday", "time": "18:00", "subject": "DS", "topic": "Trees", "task": "Revise"}],
        }
        validate_study_plan(plan)
        result = await self._run(
            "Make me a study plan based on my exams and weak subjects.",
            {"task_type": "STUDY_PLAN", "primary_tool": "get_exams", "tools": ["get_exams", "get_progress", "get_syllabus", "get_goals"], "need_tools": True, "output_type": "STUDY_PLAN"},
            json.dumps(plan),
        )
        self.assertEqual(result["type"], "STUDY_PLAN")
        self.assertGreaterEqual(len(result["toolResults"]), 3)

    async def test_ar_scene(self):
        scene = {
            "type": "AR_SCENE",
            "topic": "CPU Architecture",
            "objects": [{"name": "ALU", "position": [0, 0, 0], "description": "Arithmetic"}],
            "connections": [],
            "interactions": ["tap_to_explain"],
        }
        validate_ar_scene(scene)
        result = await self._run(
            "Show me CPU architecture as an AR model.",
            {"task_type": "AR", "primary_tool": "get_ar_lessons", "tools": ["get_ar_lessons"], "need_tools": True, "output_type": "AR_SCENE"},
            json.dumps(scene),
        )
        self.assertEqual(result["type"], "AR_SCENE")

    async def test_multi_tool(self):
        result = await self._run(
            "Analyze my recent quiz performance and tell me what I should study this week.",
            {"task_type": "MULTI_TOOL", "primary_tool": "get_quiz_results", "tools": ["get_quiz_results", "get_progress", "get_learning_materials"], "need_tools": True, "output_type": "FINAL_ANSWER"},
            json.dumps({"type": "FINAL_ANSWER", "answer": "Trees are weak; study binary trees this week using Trees.pdf."}),
        )
        self.assertEqual(len(result["toolResults"]), 3)


if __name__ == "__main__":
    unittest.main()
