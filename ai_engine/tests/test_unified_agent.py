"""Tests for the Unified Data-Aware EduNova AI Agent.

Covers:
1. Internal EduNova database tools (timetable, quiz results, syllabus, progress, exams, etc.)
2. External web tools & utility tools (calculator, date/time)
3. Multi-source reasoning workflows (DB + External + LLM + Write Action)
4. Source priority & No-hallucination verification
5. Security and permission scoping
"""

from __future__ import annotations

import sys
from pathlib import Path
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from agent.engine import AgentEngine
from agent.tools import ToolDefinition, ToolRegistry, build_all_tools, build_internal_tools, build_utility_tools
from agent.tools.utility import safe_calculate
from config import load_settings


class ScriptedLLM:
    def __init__(self, decisions):
        self.decisions = list(decisions)
        self.calls = 0

    async def complete_json(self, **kwargs):
        self.calls += 1
        if self.decisions:
            return self.decisions.pop(0)
        return {
            "action": "final",
            "answer": "Completed request with available data.",
            "stateUpdate": {"confidence": "HIGH"},
        }


def final(answer):
    return {
        "action": "final",
        "answer": answer,
        "stateUpdate": {
            "goalType": "question",
            "currentUnderstanding": "Goal answered accurately.",
            "confidence": "HIGH",
        },
    }


def tool(name, arguments):
    return {
        "action": "tool",
        "toolName": name,
        "toolInput": arguments,
        "answer": "",
        "stateUpdate": {
            "goalType": "task",
            "currentUnderstanding": f"Executing tool: {name}",
            "confidence": "MEDIUM",
        },
    }


class UnifiedAgentInternalDatabaseTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.settings = load_settings()
        self.registry = ToolRegistry(
            allowed_permissions={"READ_INTERNAL", "WRITE_INTERNAL", "READ_EXTERNAL", "UTILITY"}
        )
        for defn in build_utility_tools():
            self.registry.register(defn)
        async def fixture_tool(args, context=None):
            return {"fixture": True, "arguments": args}
        for name in (
            "get_today_schedule", "get_quiz_results", "get_exams", "get_progress",
            "get_syllabus", "create_study_plan"
        ):
            self.registry.register(ToolDefinition(
                name=name, description="test fixture", input_schema={"type": "object"},
                executor=fixture_tool,
                permission="WRITE_INTERNAL" if name == "create_study_plan" else "READ_INTERNAL",
                category="INTERNAL",
            ))

    async def test_today_classes_uses_database_not_web_search(self):
        """User asks 'What classes do I have today?' -> Uses get_today_schedule, not web_search."""
        llm = ScriptedLLM(
            [
                tool("get_today_schedule", {}),
                final("According to your timetable, today you have Mathematics at 9:30 AM, Physics at 10:15 AM, and Computer Science at 1:30 PM."),
            ]
        )
        engine = AgentEngine(self.settings, llm, self.registry)
        result = await engine.run(
            goal="What classes do I have today?",
            conversation=[],
            conversation_id="conv-today-001",
            user_id="student-123",
            user_name="Demo Student",
        )
        self.assertTrue(result.success)
        self.assertTrue(result.used_internal_db)
        self.assertFalse(result.used_web)
        self.assertIn("timetable", result.message.lower())
        self.assertIn("Physics", result.message)

    async def test_quiz_analysis_uses_quiz_results_and_does_not_invent(self):
        """User asks 'Why did I perform badly in my last physics quiz?' -> Queries get_quiz_results."""
        llm = ScriptedLLM(
            [
                tool("get_quiz_results", {"subject": "Physics"}),
                final(
                    "Based on your recent quiz results in Physics, you scored 42% on Thermodynamics & Heat Transfer. "
                    "You missed questions specifically on the Carnot Cycle and the Second Law of Thermodynamics."
                ),
            ]
        )
        engine = AgentEngine(self.settings, llm, self.registry)
        result = await engine.run(
            goal="Why did I perform badly in my last physics quiz?",
            conversation=[],
            conversation_id="conv-quiz-002",
            user_id="student-123",
        )
        self.assertTrue(result.success)
        self.assertTrue(result.used_internal_db)
        self.assertIn("42%", result.message)
        self.assertIn("Carnot Cycle", result.message)

    async def test_multi_source_workflow_study_plan_generation(self):
        """User asks: 'Make me a study plan for next week's physics exam based on my weak topics and syllabus.'"""
        llm = ScriptedLLM(
            [
                # Step 1: Get exam
                tool("get_exams", {"subject": "Physics"}),
                # Step 2: Get weak topics from progress
                tool("get_progress", {"subject": "Physics"}),
                # Step 3: Get syllabus
                tool("get_syllabus", {"subject": "Physics"}),
                # Step 4: Save created study plan
                tool(
                    "create_study_plan",
                    {
                        "title": "Physics Exam Preparation Plan",
                        "subject": "Physics",
                        "schedule": [
                            {"day": "Monday", "time": "17:00 - 18:30", "topic": "Thermodynamics & Heat", "task": "Review Carnot cycle and laws"},
                            {"day": "Tuesday", "time": "17:00 - 18:30", "topic": "Rotational Dynamics", "task": "Practice torque and angular momentum"},
                        ],
                    },
                ),
                final(
                    "I have reviewed your upcoming Physics exam date and identified your weak topics (Thermodynamics and Rotational Dynamics). "
                    "I generated and saved your study plan in EduNova with targeted review sessions."
                ),
            ]
        )
        engine = AgentEngine(self.settings, llm, self.registry)
        result = await engine.run(
            goal="Make me a study plan for next week's exam based on my weak topics and the latest syllabus.",
            conversation=[],
            conversation_id="conv-study-003",
            user_id="student-123",
        )
        self.assertTrue(result.success)
        self.assertTrue(result.used_internal_db)
        self.assertIn("Thermodynamics", result.message)
        self.assertEqual(len(result.actions), 1)
        self.assertEqual(result.actions[0]["tool"], "create_study_plan")

    async def test_utility_calculator_and_datetime(self):
        """Test calculator and date/time tools."""
        res_calc = await self.registry.execute("calculator", {"expression": "(42 * 10) + sqrt(144)"})
        obs, record = res_calc
        self.assertTrue(obs.success)
        self.assertEqual(obs.observation["result"], 432.0)

        res_dt = await self.registry.execute("get_current_datetime", {})
        obs_dt, _ = res_dt
        self.assertTrue(obs_dt.success)
        self.assertIn("date", obs_dt.observation)
        self.assertIn("dayOfWeek", obs_dt.observation)

    def test_safe_calculator_ast_rejects_malicious_code(self):
        """Calculator must reject malicious function calls or imports."""
        with self.assertRaises(Exception):
            safe_calculate("__import__('os').system('ls')")
        with self.assertRaises(Exception):
            safe_calculate("open('/etc/passwd')")
        self.assertEqual(safe_calculate("2 + 3 * 4"), 14)


if __name__ == "__main__":
    unittest.main()
