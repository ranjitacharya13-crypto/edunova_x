"""Bounded multi-tool workflow. Backend executes tools; HRM only requests them."""

from __future__ import annotations

import os
from typing import Any, Awaitable, Callable

from ..outputs import parse_structured_output, StructuredOutputError
from .context_builder import build_prompt_blocks, strip_injection
from .planner import SYSTEM_RULES, HRMPlanner
from .tool_router import authorize_tool, default_arguments, sanitize_arguments
from .validators import ValidationError, validate_ar_scene, validate_quiz, validate_study_plan

MAX_TOOL_STEPS_DEFAULT = 8

ToolExecutor = Callable[[str, dict[str, Any]], Awaitable[dict[str, Any]]]


class HRMWorkflow:
    def __init__(self, runtime, *, max_tool_steps: int | None = None):
        self.runtime = runtime
        self.planner = HRMPlanner(runtime)
        self.max_tool_steps = max_tool_steps or int(os.getenv("MAX_TOOL_STEPS", MAX_TOOL_STEPS_DEFAULT))
        self.max_tool_steps = max(1, min(self.max_tool_steps, 16))

    async def run(
        self,
        user_message: str,
        *,
        execute_tool: ToolExecutor,
        conversation: list[dict[str, str]] | None = None,
        subject: str | None = None,
        allow_external: bool | None = None,
        allow_write: bool = False,
        on_status: Callable[[str], Awaitable[None] | None] | None = None,
    ) -> dict[str, Any]:
        plan = self.planner.plan(user_message, conversation=conversation)
        tools = list(plan.get("tools") or [])
        if allow_external is None:
            allow_external = plan.get("task_type") in {"WEB_QUERY", "MULTI_TOOL"} or "web_search" in tools
        tool_results: list[dict[str, Any]] = []
        retrieved: list[dict[str, Any]] = []
        web: list[dict[str, Any]] = []
        steps = 0

        async def status(msg: str) -> None:
            if on_status is None:
                return
            result = on_status(msg)
            if hasattr(result, "__await__"):
                await result  # type: ignore[misc]

        for tool in tools:
            if steps >= self.max_tool_steps:
                break
            try:
                authorize_tool(tool, allow_external=bool(allow_external), allow_write=allow_write)
            except StructuredOutputError as exc:
                tool_results.append({"tool": tool, "success": False, "error": exc.message, "code": exc.code})
                continue
            await status(_status_for_tool(tool))
            args = default_arguments(tool, user_message, subject)
            result = await execute_tool(tool, args)
            success = bool(result.get("success", True)) and not result.get("error")
            tool_results.append({"tool": tool, "success": success, "result": result, "error": result.get("error")})
            steps += 1
            if tool == "web_search":
                for hit in result.get("results") or result.get("items") or []:
                    web.append(
                        {
                            "source_type": "web",
                            "title": hit.get("title"),
                            "url": hit.get("url"),
                            "content": strip_injection(str(hit.get("snippet") or hit.get("content") or "")),
                        }
                    )
            if tool == "retrieve_learning_materials":
                for doc in result.get("results") or result.get("chunks") or []:
                    retrieved.append(
                        {
                            "source_type": "document",
                            "source_id": doc.get("source_id") or doc.get("id"),
                            "section": doc.get("section") or doc.get("title"),
                            "content": strip_injection(str(doc.get("content") or doc.get("text") or "")),
                        }
                    )

        if plan.get("need_tools") and tools and all(not r.get("success") for r in tool_results):
            kind = "TOOL_ERROR"
            if any(r.get("tool") == "web_search" for r in tool_results):
                kind = "WEB_SEARCH_UNAVAILABLE"
            if any(r.get("tool") == "retrieve_learning_materials" for r in tool_results):
                kind = "NO_RELEVANT_CONTEXT"
            return {
                "type": kind,
                "success": False,
                "message": "Required information could not be retrieved. I will not invent it.",
                "plan": plan,
                "toolResults": tool_results,
                "sources": [],
            }

        blocks = build_prompt_blocks(
            user_message=user_message,
            system_rules=SYSTEM_RULES,
            tool_results=tool_results,
            retrieved=retrieved,
            web=web,
            conversation=conversation,
        )
        await status("Preparing your answer...")
        raw = self.runtime.generate_text(
            system_prompt=blocks["system"],
            user_prompt=blocks["user"],
            untrusted=blocks["untrusted"],
            max_tokens=256,
        )
        try:
            structured = parse_structured_output(raw)
        except StructuredOutputError as exc:
            return {
                "type": "ERROR",
                "success": False,
                "message": exc.message,
                "code": exc.code,
                "plan": plan,
                "toolResults": tool_results,
            }
        payload = structured.public()
        try:
            if structured.type == "QUIZ":
                payload = validate_quiz(payload)
            elif structured.type == "STUDY_PLAN":
                payload = validate_study_plan(payload)
            elif structured.type == "AR_SCENE":
                payload = validate_ar_scene(payload)
        except ValidationError as exc:
            return {"type": "ERROR", "success": False, "message": exc.message, "code": exc.code, "plan": plan}

        if structured.type == "FINAL_ANSWER" and plan.get("task_type") in {"DB_QUERY"} and not tool_results:
            payload = {
                "type": "NEED_MORE_INFORMATION",
                "answer": "I do not have that student record in context, so I will not guess.",
            }
        message = payload.get("answer") or payload.get("title") or structured.raw_text
        return {
            "type": payload.get("type", structured.type),
            "success": True,
            "message": message,
            "structured": payload,
            "plan": plan,
            "toolResults": [{"tool": r["tool"], "success": r["success"]} for r in tool_results],
            "sources": [s for s in (blocks.get("sources") or []) if isinstance(s, dict)],
            "raw": raw,
        }


def _status_for_tool(tool: str) -> str:
    mapping = {
        "get_attendance": "Checking your attendance...",
        "get_exams": "Checking your exam schedule...",
        "get_timetable": "Checking your timetable...",
        "get_today_schedule": "Checking today's classes...",
        "get_upcoming_classes": "Checking upcoming classes...",
        "get_syllabus": "Searching your syllabus...",
        "retrieve_learning_materials": "Searching your materials...",
        "get_progress": "Reviewing your progress...",
        "get_quiz_history": "Reviewing your quiz history...",
        "get_quiz_results": "Reviewing your quiz results...",
        "web_search": "Searching the web...",
        "create_study_plan": "Preparing your study plan...",
        "create_quiz": "Preparing your quiz...",
        "get_ar_lessons": "Looking up AR lessons...",
    }
    return mapping.get(tool, f"Using {tool}...")
