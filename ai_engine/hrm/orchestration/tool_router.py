"""Map HRM high-level decisions onto the existing allowlisted ToolRegistry.

The model never sees credentials, SQL, or another student's id. Identity is
injected by the backend from the authenticated request.
"""

from __future__ import annotations

from typing import Any

from ..config import TOOL_NAMES
from ..outputs import ALLOWED_TOOLS, FORBIDDEN_TOOL_ARGS, StructuredOutputError


def sanitize_arguments(tool: str, arguments: dict[str, Any] | None) -> dict[str, Any]:
    arguments = dict(arguments or {})
    for key in list(arguments):
        if key in FORBIDDEN_TOOL_ARGS:
            arguments.pop(key)
    if tool == "web_search":
        arguments.setdefault("query", "")
        arguments["query"] = str(arguments["query"])[:480]
    if tool == "retrieve_learning_materials":
        arguments["query"] = str(arguments.get("query") or "")[:4000]
    if tool == "calculator":
        arguments["expression"] = str(arguments.get("expression") or "")[:200]
    return arguments


def authorize_tool(tool: str, *, allow_external: bool, allow_write: bool) -> None:
    if tool not in ALLOWED_TOOLS:
        raise StructuredOutputError("UNKNOWN_TOOL", f"{tool} is not allowlisted")
    if tool in {"web_search", "open_url", "extract_webpage"} and not allow_external:
        raise StructuredOutputError("PERMISSION_DENIED", "External tools require an explicit web/research intent")
    writes = {"create_quiz", "save_quiz", "create_study_plan", "create_note", "set_goal", "create_timetable", "update_timetable"}
    if tool in writes and not allow_write:
        raise StructuredOutputError("PERMISSION_DENIED", "Write tools require user confirmation path")


def tools_from_plan(plan: dict[str, Any]) -> list[str]:
    names = []
    for name in plan.get("tools") or []:
        if name in ALLOWED_TOOLS and name not in names:
            names.append(name)
    primary = plan.get("primary_tool")
    if primary in ALLOWED_TOOLS and primary not in names and primary != "none":
        names.insert(0, primary)
    return names


def default_arguments(tool: str, user_message: str, subject: str | None = None) -> dict[str, Any]:
    args: dict[str, Any] = {}
    if subject and tool in {
        "get_syllabus",
        "get_learning_materials",
        "get_progress",
        "get_quiz_history",
        "get_quiz_results",
        "get_exams",
        "get_notes",
        "get_study_history",
    }:
        args["subject"] = subject
    if tool in {"web_search", "retrieve_learning_materials"}:
        args["query"] = user_message[:480]
    return sanitize_arguments(tool, args)


def known_tool_index(name: str) -> int:
    try:
        return TOOL_NAMES.index(name)
    except ValueError:
        return 0
