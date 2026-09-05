"""Application Tools for EduNova AI Agent (Internal Data & Actions).

Integrates the AI Agent with the EduNova application backend:
- Reads: student profile, timetable, today's schedule, syllabus, quiz results, progress, assignments, exams, attendance.
- Writes: create/update timetable, create study session, save quiz, update progress, create note, set goal, create study plan.

All internal tool executions are strictly user-scoped and authenticated.
"""

from __future__ import annotations

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
                safe_error = "EduNova backend rejected the tool request"
                try:
                    safe_error = str(response.json().get("error") or safe_error)[:300]
                except Exception:
                    pass
                raise RuntimeError(f"{safe_error} (HTTP {response.status_code})")
        except RuntimeError:
            raise
        except Exception as exc:
            logger.warning("Remote application tool %s unavailable: %s", tool_name, type(exc).__name__)
            raise RuntimeError("EduNova application data is temporarily unavailable") from exc



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
