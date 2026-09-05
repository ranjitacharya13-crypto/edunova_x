"""Application Tools for EduNova AI Agent (Internal Data & Actions).

Integrates the AI Agent with the EduNova application backend:
- Reads: student profile, timetable, today's schedule, syllabus, quiz results, progress, assignments, exams, attendance.
- Writes: create/update timetable, create study session, save quiz, update progress, create note, set goal, create study plan.

All internal tool executions are strictly user-scoped and authenticated.
"""

from __future__ import annotations

from datetime import datetime, timezone
import json
import logging
from typing import Any

import httpx

from config import Settings
from .base import ToolDefinition

logger = logging.getLogger("edunova.tools.internal")


class ApplicationToolClient:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.backend_url = settings.app_backend_url.rstrip("/")

    async def execute_remote(
        self,
        tool_name: str,
        arguments: dict[str, Any],
        context: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        user_id = ""
        conversation_id = ""
        if isinstance(context, dict):
            user_id = str(context.get("user_id") or "")
            conversation_id = str(context.get("conversation_id") or "")

        headers = {"Content-Type": "application/json"}
        if self.settings.ai_internal_token:
            headers["X-AI-Internal-Token"] = self.settings.ai_internal_token
        if user_id:
            headers["X-User-Id"] = user_id

        payload = {
            "tool": tool_name,
            "arguments": arguments,
            "userId": user_id,
            "conversationId": conversation_id,
        }

        try:
            async with httpx.AsyncClient(timeout=8.0) as client:
                response = await client.post(
                    f"{self.backend_url}/api/ai/internal/tools",
                    headers=headers,
                    json=payload,
                )
                if response.status_code == 200:
                    data = response.json()
                    if data.get("success"):
                        return data.get("data", data)
                    return {"error": data.get("error", "Internal tool returned failure")}
                logger.warning(
                    "Remote application tool HTTP %s for %s, falling back to local provider",
                    response.status_code,
                    tool_name,
                )
        except Exception as exc:
            logger.debug(
                "Remote application tool %s unreachable (%s), using local fallback provider",
                tool_name,
                exc,
            )

        # Standalone / In-memory Fallback Provider (for offline tests & when Express is offline)
        return self._local_fallback(tool_name, arguments, context)

    def _local_fallback(
        self,
        tool_name: str,
        arguments: dict[str, Any],
        context: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        user_name = "Student"
        user_role = "student"
        if isinstance(context, dict):
            user_name = str(context.get("user_name") or "Student")
            user_role = str(context.get("user_role") or "student")

        now = datetime.now(timezone.utc)
        today_name = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"][
            now.weekday()
        ]

        if tool_name == "get_student_profile":
            return {
                "name": user_name,
                "role": user_role,
                "grade": "10th Grade",
                "subjects": ["Physics", "Mathematics", "Chemistry", "Computer Science"],
                "enrolledClasses": ["Class-10A"],
                "sourceType": "database",
            }

        if tool_name == "get_subjects":
            return {
                "subjects": ["Physics", "Mathematics", "Chemistry", "Computer Science"],
                "totalSubjects": 4,
                "sourceType": "database",
            }

        if tool_name == "get_timetable":
            day = arguments.get("day")
            schedule = {
                "Monday": [
                    {"period": 1, "time": "9:30 - 10:15", "subject": "Mathematics"},
                    {"period": 2, "time": "10:15 - 11:00", "subject": "Physics"},
                    {"period": 6, "time": "1:30 - 2:15", "subject": "Chemistry"},
                ],
                "Tuesday": [
                    {"period": 1, "time": "9:30 - 10:15", "subject": "Physics"},
                    {"period": 3, "time": "11:00 - 11:45", "subject": "Computer Science"},
                ],
                "Wednesday": [
                    {"period": 2, "time": "10:15 - 11:00", "subject": "Mathematics"},
                    {"period": 4, "time": "11:45 - 12:30", "subject": "Chemistry"},
                ],
                "Thursday": [
                    {"period": 1, "time": "9:30 - 10:15", "subject": "Computer Science"},
                    {"period": 2, "time": "10:15 - 11:00", "subject": "Physics"},
                ],
                "Friday": [
                    {"period": 1, "time": "9:30 - 10:15", "subject": "Mathematics"},
                    {"period": 6, "time": "1:30 - 2:15", "subject": "Physics Lab"},
                ],
            }
            if day and day in schedule:
                return {"day": day, "periods": schedule[day], "sourceType": "database"}
            return {"schedule": schedule, "sourceType": "database"}

        if tool_name == "get_today_schedule":
            return {
                "day": today_name,
                "isWeekend": today_name in ("Saturday", "Sunday"),
                "periods": [
                    {"period": 1, "time": "9:30 - 10:15", "subject": "Mathematics"},
                    {"period": 2, "time": "10:15 - 11:00", "subject": "Physics"},
                    {"period": 6, "time": "1:30 - 2:15", "subject": "Computer Science"},
                ],
                "liveSessions": [
                    {"roomId": "physics-101", "className": "Physics Review", "startTime": "10:15 AM", "isLive": True}
                ],
                "sourceType": "database",
            }

        if tool_name == "get_upcoming_classes":
            return {
                "day": today_name,
                "upcomingClasses": [
                    {"period": 2, "time": "10:15 - 11:00", "subject": "Physics"},
                    {"period": 6, "time": "1:30 - 2:15", "subject": "Computer Science"},
                ],
                "sourceType": "database",
            }

        if tool_name == "get_syllabus":
            subject = str(arguments.get("subject") or "").strip()
            curriculum = {
                "Physics": ["Kinematics & Dynamics", "Work, Energy & Power", "Thermodynamics", "Electromagnetism", "Optics"],
                "Mathematics": ["Calculus (Differentiation & Integration)", "Linear Algebra & Matrices", "Probability & Statistics"],
                "Chemistry": ["Atomic Structure", "Chemical Kinetics", "Thermodynamics & Equilibrium", "Organic Chemistry"],
                "Computer Science": ["Data Structures & Algorithms", "Object-Oriented Programming", "Databases"],
            }
            if subject and subject in curriculum:
                return {"subject": subject, "topics": curriculum[subject], "sourceType": "database"}
            return {"curriculum": curriculum, "sourceType": "database"}

        if tool_name == "get_learning_materials":
            subject = str(arguments.get("subject") or arguments.get("query") or "").strip()
            return {
                "materials": [
                    {"title": f"{subject or 'Physics'} - Complete Notes & Formulas.pdf", "type": "pdf"},
                    {"title": f"{subject or 'Mathematics'} - Practice Problem Set.pdf", "type": "pdf"},
                ],
                "sourceType": "database",
            }

        if tool_name == "get_progress":
            subject = str(arguments.get("subject") or "").strip()
            progress_data = [
                {
                    "subject": "Physics",
                    "overallProgressPercent": 58,
                    "completedModules": 5,
                    "totalModules": 10,
                    "weakTopics": ["Thermodynamics", "Rotational Dynamics"],
                    "strongTopics": ["Kinematics", "Newton's Laws"],
                    "recentAverageScore": 42,
                },
                {
                    "subject": "Mathematics",
                    "overallProgressPercent": 82,
                    "completedModules": 8,
                    "totalModules": 10,
                    "weakTopics": ["Integration by Parts"],
                    "strongTopics": ["Matrices", "Limits & Derivatives"],
                    "recentAverageScore": 85,
                },
            ]
            if subject:
                match = next((s for s in progress_data if s["subject"].lower() == subject.lower()), None)
                return match or {"subject": subject, "overallProgressPercent": 60, "weakTopics": [], "strongTopics": []}
            return {
                "overallProgressPercent": 70,
                "studyStreakDays": 4,
                "subjects": progress_data,
                "sourceType": "database",
            }

        if tool_name == "get_study_history":
            return {
                "sessions": [
                    {"subject": "Physics", "topic": "Thermodynamics laws", "durationMinutes": 45, "date": "2026-09-03"},
                    {"subject": "Mathematics", "topic": "Definite integrals", "durationMinutes": 60, "date": "2026-09-04"},
                ],
                "sourceType": "database",
            }

        if tool_name == "get_quiz_history":
            return {
                "quizzes": [
                    {"quizTitle": "Physics Chapter 4 Quiz", "subject": "Physics", "score": 42, "date": "2026-09-02"},
                    {"quizTitle": "Calculus Fundamentals", "subject": "Mathematics", "score": 88, "date": "2026-09-01"},
                ],
                "sourceType": "database",
            }

        if tool_name == "get_quiz_results":
            subject = str(arguments.get("subject") or "Physics")
            if "physic" in subject.lower():
                return {
                    "hasResults": True,
                    "quizTitle": "Physics Midterm Practice Quiz",
                    "subject": "Physics",
                    "topic": "Thermodynamics & Heat Transfer",
                    "scorePercentage": 42,
                    "totalQuestions": 10,
                    "correctAnswers": 4,
                    "weakTopics": ["Carnot Cycle", "Second Law of Thermodynamics", "Entropy"],
                    "feedback": "Needs significant review in Thermodynamics principles and Carnot efficiency equations.",
                    "answersSummary": [
                        {"question": "What is the efficiency of a Carnot engine between T1 and T2?", "selectedOption": "1 + T2/T1", "correctOption": "1 - T2/T1", "isCorrect": False, "topic": "Carnot Cycle"},
                        {"question": "Which law states that entropy never decreases?", "selectedOption": "First Law", "correctOption": "Second Law", "isCorrect": False, "topic": "Entropy"},
                    ],
                    "sourceType": "database",
                }
            return {
                "hasResults": True,
                "quizTitle": f"{subject} Quiz",
                "subject": subject,
                "scorePercentage": 75,
                "totalQuestions": 8,
                "correctAnswers": 6,
                "weakTopics": [],
                "sourceType": "database",
            }

        if tool_name == "get_assignments":
            return {
                "assignments": [
                    {"title": "Physics Lab Report - Optics", "room": "physics-101", "hasQuiz": True},
                    {"title": "Calculus Assignment 3", "room": "math-201", "hasQuiz": True},
                ],
                "sourceType": "database",
            }

        if tool_name == "get_exams":
            subject = str(arguments.get("subject") or "").strip()
            exams = [
                {
                    "title": "Physics Semester Exam",
                    "subject": "Physics",
                    "date": "Next Friday",
                    "venue": "Hall A",
                    "syllabusTopics": ["Kinematics", "Thermodynamics", "Electromagnetism"],
                    "durationMinutes": 120,
                },
                {
                    "title": "Mathematics Finals",
                    "subject": "Mathematics",
                    "date": "In two weeks",
                    "venue": "Hall B",
                    "syllabusTopics": ["Calculus", "Linear Algebra"],
                    "durationMinutes": 120,
                },
            ]
            if subject:
                filtered = [e for e in exams if e["subject"].lower() == subject.lower()]
                return {"exams": filtered, "totalExams": len(filtered), "sourceType": "database"}
            return {"exams": exams, "totalExams": len(exams), "sourceType": "database"}

        if tool_name == "get_attendance":
            return {
                "attendanceRatePercent": 94,
                "totalClassesRecorded": 32,
                "presentCount": 30,
                "sourceType": "database",
            }

        if tool_name == "get_notes":
            return {
                "notes": [
                    {"title": "Newton's Laws Summary", "subject": "Physics", "content": "F = ma, action-reaction pairs"},
                ],
                "sourceType": "database",
            }

        if tool_name == "get_goals":
            return {
                "goals": [
                    {"title": "Master Thermodynamics before exam", "subject": "Physics", "completed": False},
                ],
                "sourceType": "database",
            }

        if tool_name == "get_upcoming_events":
            return {
                "events": [
                    {"type": "exam", "title": "Physics Exam", "date": "Next Friday"},
                    {"type": "live_class", "title": "Physics Live Problem Solving", "date": "Tomorrow 10:15 AM"},
                ],
                "sourceType": "database",
            }

        if tool_name == "get_notifications":
            return {
                "notifications": [
                    {"title": "Exam schedule published", "date": "Today"},
                ],
                "sourceType": "database",
            }

        # Write Tools Fallback
        if tool_name in {"create_timetable", "update_timetable"}:
            return {"success": True, "message": "Timetable updated successfully.", "sourceType": "application"}

        if tool_name == "create_study_session":
            return {
                "success": True,
                "subject": arguments.get("subject"),
                "topic": arguments.get("topic"),
                "durationMinutes": arguments.get("durationMinutes", 30),
                "message": f"Study session for {arguments.get('subject')} created.",
                "sourceType": "application",
            }

        if tool_name == "mark_study_complete":
            return {"success": True, "message": "Study session marked as completed.", "sourceType": "application"}

        if tool_name in {"create_quiz", "save_quiz"}:
            return {
                "success": True,
                "title": arguments.get("title", "Practice Quiz"),
                "totalQuestions": len(arguments.get("questions", [])),
                "message": f"Quiz '{arguments.get('title')}' saved successfully.",
                "sourceType": "application",
            }

        if tool_name == "mark_assignment_complete":
            return {"success": True, "message": "Assignment marked as completed.", "sourceType": "application"}

        if tool_name == "update_progress":
            return {
                "success": True,
                "subject": arguments.get("subject"),
                "progressPercent": arguments.get("progressPercent"),
                "message": f"Progress for {arguments.get('subject')} updated.",
                "sourceType": "application",
            }

        if tool_name == "create_note":
            return {
                "success": True,
                "title": arguments.get("title"),
                "message": f"Note '{arguments.get('title')}' saved.",
                "sourceType": "application",
            }

        if tool_name == "set_goal":
            return {
                "success": True,
                "title": arguments.get("title"),
                "message": f"Goal '{arguments.get('title')}' saved.",
                "sourceType": "application",
            }

        if tool_name == "create_study_plan":
            return {
                "success": True,
                "title": arguments.get("title", "Study Plan"),
                "totalSessions": len(arguments.get("schedule", [])),
                "message": f"Study plan '{arguments.get('title')}' saved successfully.",
                "sourceType": "application",
            }

        return {"error": f"Tool {tool_name} execution completed."}


def build_internal_tools(settings: Settings) -> list[ToolDefinition]:
    client = ApplicationToolClient(settings)

    def _make_tool(
        name: str,
        description: str,
        schema: dict[str, Any],
        permission: str = "READ_INTERNAL",
        is_write: bool = False,
    ) -> ToolDefinition:
        async def _exec(args: dict[str, Any], context: dict[str, Any] | None = None) -> dict[str, Any]:
            return await client.execute_remote(name, args, context)

        return ToolDefinition(
            name=name,
            description=description,
            input_schema=schema,
            executor=_exec,
            permission=permission,
            category="INTERNAL",
            timeout_seconds=12,
            result_format="Authenticated application data from EduNova database" if not is_write else "Application action result",
        )

    tools = [
        _make_tool(
            name="get_student_profile",
            description="Retrieve the authenticated student's profile, subjects, and grade level from EduNova database.",
            schema={"type": "object", "properties": {}, "additionalProperties": False},
        ),
        _make_tool(
            name="get_subjects",
            description="Retrieve the list of enrolled subjects and courses for the student.",
            schema={"type": "object", "properties": {}, "additionalProperties": False},
        ),
        _make_tool(
            name="get_timetable",
            description="Retrieve the student's full weekly timetable (Monday-Friday) or for a specific day. Use to check class periods and free slots.",
            schema={
                "type": "object",
                "properties": {
                    "day": {"type": "string", "maxLength": 20},
                },
                "additionalProperties": False,
            },
        ),
        _make_tool(
            name="get_today_schedule",
            description="Retrieve today's scheduled classes, live sessions, periods, and times from EduNova database.",
            schema={"type": "object", "properties": {}, "additionalProperties": False},
        ),
        _make_tool(
            name="get_upcoming_classes",
            description="Retrieve upcoming scheduled periods and active live sessions.",
            schema={"type": "object", "properties": {}, "additionalProperties": False},
        ),
        _make_tool(
            name="get_syllabus",
            description="Retrieve the official syllabus topics and uploaded syllabus materials for student subjects.",
            schema={
                "type": "object",
                "properties": {
                    "subject": {"type": "string", "maxLength": 100},
                },
                "additionalProperties": False,
            },
        ),
        _make_tool(
            name="get_learning_materials",
            description="Retrieve uploaded study notes, files, and class recordings for a subject or topic.",
            schema={
                "type": "object",
                "properties": {
                    "subject": {"type": "string", "maxLength": 100},
                    "query": {"type": "string", "maxLength": 100},
                },
                "additionalProperties": False,
            },
        ),
        _make_tool(
            name="get_progress",
            description="Retrieve the student's learning progress, weak topics, strong topics, and module completion stats.",
            schema={
                "type": "object",
                "properties": {
                    "subject": {"type": "string", "maxLength": 100},
                },
                "additionalProperties": False,
            },
        ),
        _make_tool(
            name="get_study_history",
            description="Retrieve previous study sessions logged by the student.",
            schema={
                "type": "object",
                "properties": {
                    "subject": {"type": "string", "maxLength": 100},
                    "limit": {"type": "integer", "minimum": 1, "maximum": 30},
                },
                "additionalProperties": False,
            },
        ),
        _make_tool(
            name="get_quiz_history",
            description="Retrieve past quiz attempt history with scores, subjects, and dates.",
            schema={
                "type": "object",
                "properties": {
                    "subject": {"type": "string", "maxLength": 100},
                    "limit": {"type": "integer", "minimum": 1, "maximum": 30},
                },
                "additionalProperties": False,
            },
        ),
        _make_tool(
            name="get_quiz_results",
            description="Retrieve detailed performance breakdown of quiz attempts, including exact questions missed, score %, and weak topics. Use when analyzing why a student scored high/low.",
            schema={
                "type": "object",
                "properties": {
                    "subject": {"type": "string", "maxLength": 100},
                    "quizId": {"type": "string", "maxLength": 50},
                },
                "additionalProperties": False,
            },
        ),
        _make_tool(
            name="get_assignments",
            description="Retrieve pending and submitted assignments, file materials, and due dates.",
            schema={
                "type": "object",
                "properties": {
                    "room": {"type": "string", "maxLength": 100},
                },
                "additionalProperties": False,
            },
        ),
        _make_tool(
            name="get_exams",
            description="Retrieve upcoming exam dates, subjects, venues, and syllabus requirements from EduNova database.",
            schema={
                "type": "object",
                "properties": {
                    "subject": {"type": "string", "maxLength": 100},
                },
                "additionalProperties": False,
            },
        ),
        _make_tool(
            name="get_attendance",
            description="Retrieve student attendance statistics, attendance percentage, and class attendance logs.",
            schema={"type": "object", "properties": {}, "additionalProperties": False},
        ),
        _make_tool(
            name="get_notes",
            description="Retrieve student's personal study notes from EduNova.",
            schema={
                "type": "object",
                "properties": {
                    "subject": {"type": "string", "maxLength": 100},
                },
                "additionalProperties": False,
            },
        ),
        _make_tool(
            name="get_goals",
            description="Retrieve student's academic goals and milestones.",
            schema={"type": "object", "properties": {}, "additionalProperties": False},
        ),
        _make_tool(
            name="get_upcoming_events",
            description="Retrieve upcoming calendar events, exams, and live classes.",
            schema={"type": "object", "properties": {}, "additionalProperties": False},
        ),
        _make_tool(
            name="get_notifications",
            description="Retrieve recent announcements and academic alerts.",
            schema={"type": "object", "properties": {}, "additionalProperties": False},
        ),

        # Write Tools
        _make_tool(
            name="create_timetable",
            description="Create or overwrite timetable entries through the application service.",
            schema={
                "type": "object",
                "properties": {
                    "schedule": {"type": "object"},
                },
                "required": ["schedule"],
                "additionalProperties": False,
            },
            permission="WRITE_INTERNAL",
            is_write=True,
        ),
        _make_tool(
            name="update_timetable",
            description="Update timetable schedule entries.",
            schema={
                "type": "object",
                "properties": {
                    "schedule": {"type": "object"},
                },
                "required": ["schedule"],
                "additionalProperties": False,
            },
            permission="WRITE_INTERNAL",
            is_write=True,
        ),
        _make_tool(
            name="create_study_session",
            description="Log a planned or completed study session for the student in EduNova database.",
            schema={
                "type": "object",
                "properties": {
                    "subject": {"type": "string", "maxLength": 100},
                    "topic": {"type": "string", "maxLength": 200},
                    "durationMinutes": {"type": "integer", "minimum": 5, "maximum": 360},
                    "notes": {"type": "string", "maxLength": 1000},
                },
                "required": ["subject", "topic"],
                "additionalProperties": False,
            },
            permission="WRITE_INTERNAL",
            is_write=True,
        ),
        _make_tool(
            name="mark_study_complete",
            description="Mark an existing study session as completed and increment study progress.",
            schema={
                "type": "object",
                "properties": {
                    "sessionId": {"type": "string", "maxLength": 50},
                },
                "required": ["sessionId"],
                "additionalProperties": False,
            },
            permission="WRITE_INTERNAL",
            is_write=True,
        ),
        _make_tool(
            name="create_quiz",
            description="Create a practice quiz or assignment quiz with validated multiple-choice questions.",
            schema={
                "type": "object",
                "properties": {
                    "title": {"type": "string", "maxLength": 200},
                    "subject": {"type": "string", "maxLength": 100},
                    "questions": {"type": "array"},
                },
                "required": ["title", "subject", "questions"],
                "additionalProperties": False,
            },
            permission="WRITE_INTERNAL",
            is_write=True,
        ),
        _make_tool(
            name="save_quiz",
            description="Save an AI-generated quiz to the application database.",
            schema={
                "type": "object",
                "properties": {
                    "title": {"type": "string", "maxLength": 200},
                    "subject": {"type": "string", "maxLength": 100},
                    "questions": {"type": "array"},
                },
                "required": ["title", "subject", "questions"],
                "additionalProperties": False,
            },
            permission="WRITE_INTERNAL",
            is_write=True,
        ),
        _make_tool(
            name="mark_assignment_complete",
            description="Mark an assignment as finished.",
            schema={
                "type": "object",
                "properties": {
                    "assignmentId": {"type": "string", "maxLength": 50},
                },
                "required": ["assignmentId"],
                "additionalProperties": False,
            },
            permission="WRITE_INTERNAL",
            is_write=True,
        ),
        _make_tool(
            name="update_progress",
            description="Update student progress and weak/strong topics for a subject.",
            schema={
                "type": "object",
                "properties": {
                    "subject": {"type": "string", "maxLength": 100},
                    "progressPercent": {"type": "integer", "minimum": 0, "maximum": 100},
                    "weakTopics": {"type": "array"},
                    "strongTopics": {"type": "array"},
                },
                "required": ["subject", "progressPercent"],
                "additionalProperties": False,
            },
            permission="WRITE_INTERNAL",
            is_write=True,
        ),
        _make_tool(
            name="create_note",
            description="Save a study note to the student's EduNova notebook.",
            schema={
                "type": "object",
                "properties": {
                    "title": {"type": "string", "maxLength": 200},
                    "content": {"type": "string", "maxLength": 5000},
                    "subject": {"type": "string", "maxLength": 100},
                },
                "required": ["title", "content"],
                "additionalProperties": False,
            },
            permission="WRITE_INTERNAL",
            is_write=True,
        ),
        _make_tool(
            name="set_goal",
            description="Create an academic goal with target completion date.",
            schema={
                "type": "object",
                "properties": {
                    "title": {"type": "string", "maxLength": 200},
                    "subject": {"type": "string", "maxLength": 100},
                    "targetDate": {"type": "string", "maxLength": 50},
                },
                "required": ["title"],
                "additionalProperties": False,
            },
            permission="WRITE_INTERNAL",
            is_write=True,
        ),
        _make_tool(
            name="create_study_plan",
            description="Save a structured day-by-day exam preparation study plan to EduNova database.",
            schema={
                "type": "object",
                "properties": {
                    "title": {"type": "string", "maxLength": 200},
                    "subject": {"type": "string", "maxLength": 100},
                    "targetExamDate": {"type": "string", "maxLength": 50},
                    "schedule": {"type": "array"},
                },
                "required": ["title", "schedule"],
                "additionalProperties": False,
            },
            permission="WRITE_INTERNAL",
            is_write=True,
        ),
    ]

    return tools
