"""Structured output protocol. Backend validates; the model never executes tools."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any

OUTPUT_TYPES = (
    "FINAL_ANSWER",
    "TOOL_CALL",
    "TOOL_RESULT",
    "SEARCH_REQUEST",
    "QUIZ",
    "STUDY_PLAN",
    "AR_SCENE",
    "SUMMARY",
    "ERROR",
    "NEED_MORE_INFORMATION",
    "NO_RELEVANT_CONTEXT",
    "WEB_SEARCH_UNAVAILABLE",
    "TOOL_ERROR",
)

ALLOWED_TOOLS = {
    "get_student_profile",
    "get_subjects",
    "get_timetable",
    "get_today_schedule",
    "get_upcoming_classes",
    "get_syllabus",
    "get_learning_materials",
    "get_progress",
    "get_study_history",
    "get_quiz_history",
    "get_quiz_results",
    "get_assignments",
    "get_exams",
    "get_attendance",
    "get_notes",
    "get_goals",
    "get_upcoming_events",
    "get_notifications",
    "retrieve_learning_materials",
    "web_search",
    "open_url",
    "extract_webpage",
    "calculator",
    "get_current_datetime",
    "get_ar_lessons",
    "create_quiz",
    "save_quiz",
    "create_study_plan",
    "open_feature",
}

FORBIDDEN_TOOL_ARGS = {
    "sql",
    "query_sql",
    "password",
    "token",
    "api_key",
    "secret",
    "userId",
    "user_id",
    "owner_id",
    "ownerId",
    "shell",
    "command",
    "path",
    "filename_abs",
}


class StructuredOutputError(ValueError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass
class StructuredOutput:
    type: str
    payload: dict[str, Any] = field(default_factory=dict)
    raw_text: str = ""

    def public(self) -> dict[str, Any]:
        body = {"type": self.type, **self.payload}
        return body


def _extract_json(text: str) -> dict[str, Any] | None:
    candidate = (text or "").strip()
    if candidate.startswith("```"):
        candidate = re.sub(r"^```(?:json)?\s*", "", candidate, flags=re.IGNORECASE)
        candidate = re.sub(r"\s*```$", "", candidate)
    try:
        parsed = json.loads(candidate)
        if isinstance(parsed, dict):
            return parsed
    except json.JSONDecodeError:
        pass
    decoder = json.JSONDecoder()
    for match in re.finditer(r"\{", candidate):
        try:
            parsed, _ = decoder.raw_decode(candidate[match.start() :])
            if isinstance(parsed, dict):
                return parsed
        except json.JSONDecodeError:
            continue
    return None


def parse_structured_output(text: str) -> StructuredOutput:
    """Parse model text into a validated structured object.

    If the model produced plain language with no JSON, treat it as FINAL_ANSWER.
    Never execute anything here.
    """
    parsed = _extract_json(text)
    if parsed is None:
        answer = (text or "").strip()
        if not answer:
            raise StructuredOutputError("INVALID_MODEL_OUTPUT", "Model produced empty output")
        return StructuredOutput(type="FINAL_ANSWER", payload={"answer": answer}, raw_text=text)
    kind = str(parsed.get("type") or "").upper()
    if kind not in OUTPUT_TYPES:
        if "tool" in parsed and parsed.get("tool"):
            kind = "TOOL_CALL"
        elif "answer" in parsed:
            kind = "FINAL_ANSWER"
        else:
            raise StructuredOutputError("INVALID_MODEL_OUTPUT", f"Unknown output type {parsed.get('type')!r}")
    if kind == "TOOL_CALL":
        tool = str(parsed.get("tool") or "")
        if tool not in ALLOWED_TOOLS:
            raise StructuredOutputError("UNKNOWN_TOOL", f"Tool {tool!r} is not allowlisted")
        arguments = parsed.get("arguments") or {}
        if not isinstance(arguments, dict):
            raise StructuredOutputError("INVALID_TOOL_INPUT", "Tool arguments must be an object")
        for forbidden in FORBIDDEN_TOOL_ARGS:
            if forbidden in arguments:
                raise StructuredOutputError("INVALID_TOOL_INPUT", f"Argument {forbidden!r} is not allowed")
        return StructuredOutput(type="TOOL_CALL", payload={"tool": tool, "arguments": arguments}, raw_text=text)
    if kind == "FINAL_ANSWER":
        return StructuredOutput(
            type="FINAL_ANSWER",
            payload={"answer": str(parsed.get("answer") or parsed.get("message") or "")},
            raw_text=text,
        )
    return StructuredOutput(type=kind, payload={k: v for k, v in parsed.items() if k != "type"}, raw_text=text)
