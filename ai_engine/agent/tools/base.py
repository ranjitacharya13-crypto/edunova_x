"""Generic, permission-aware tool registry for EduNova AI Agent."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
import inspect
import logging
from time import monotonic
from typing import Any

from ..models import Observation, ToolCallRecord

logger = logging.getLogger("edunova.agent.tools")

ToolExecutor = Callable[..., Awaitable[dict[str, Any]]]


class ToolSchemaError(ValueError):
    code = "INVALID_TOOL_INPUT"


def _validate_input(schema: dict[str, Any], arguments: dict[str, Any]) -> None:
    """Full nested JSON-schema validation, not just top-level type checks."""
    from jsonschema import Draft202012Validator
    errors = sorted(Draft202012Validator(schema).iter_errors(arguments), key=lambda e: str(e.path))
    if errors:
        raise ToolSchemaError(f"Invalid tool input at {'.'.join(map(str, errors[0].path)) or 'arguments'}")


@dataclass(frozen=True, slots=True)
class ToolDefinition:
    name: str
    description: str
    input_schema: dict[str, Any]
    executor: ToolExecutor
    permission: str = "READ_EXTERNAL"  # READ_INTERNAL | WRITE_INTERNAL | READ_EXTERNAL | UTILITY
    category: str = "EXTERNAL"  # INTERNAL | EXTERNAL | UTILITY
    timeout_seconds: int = 15
    result_format: str = "object"

    def agent_spec(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "description": self.description,
            "category": self.category,
            "inputSchema": self.input_schema,
            "permission": self.permission,
            "timeoutSeconds": self.timeout_seconds,
            "resultFormat": self.result_format,
        }


class ToolRegistry:
    def __init__(self, allowed_permissions: set[str] | None = None):
        self._tools: dict[str, ToolDefinition] = {}
        self.allowed_permissions = (
            allowed_permissions
            if allowed_permissions is not None
            else {"READ_INTERNAL", "WRITE_INTERNAL", "READ_EXTERNAL", "UTILITY"}
        )

    def register(self, tool: ToolDefinition) -> None:
        if not tool.name or tool.name in self._tools:
            raise ValueError(f"Tool already registered or invalid: {tool.name!r}")
        self._tools[tool.name] = tool

    def specs(self) -> list[dict[str, Any]]:
        return [tool.agent_spec() for tool in self._tools.values()]

    def has(self, name: str) -> bool:
        return name in self._tools

    def get(self, name: str) -> ToolDefinition | None:
        return self._tools.get(name)

    async def execute(
        self, name: str, arguments: dict[str, Any], context: dict[str, Any] | None = None
    ) -> tuple[Observation, ToolCallRecord]:
        started = monotonic()
        tool = self._tools.get(name)
        source_type = "external"
        if tool:
            if tool.category == "INTERNAL":
                source_type = "database"
            elif tool.category == "UTILITY":
                source_type = "utility"

        if not tool:
            return self._failure(
                name, arguments, started, "UNKNOWN_TOOL", "Requested tool is not registered", source_type
            )
        if tool.permission not in self.allowed_permissions:
            return self._failure(
                name,
                arguments,
                started,
                "PERMISSION_DENIED",
                f"Permission {tool.permission} requires explicit approval",
                source_type,
            )

        try:
            _validate_input(tool.input_schema, arguments)
            
            # Check if executor accepts context parameter
            sig = inspect.signature(tool.executor)
            if "context" in sig.parameters:
                task = tool.executor(arguments, context=context)
            else:
                task = tool.executor(arguments)

            result = await asyncio.wait_for(task, timeout=tool.timeout_seconds)
            if not isinstance(result, dict):
                raise ToolSchemaError("Tool returned an invalid result")
            if result.get("success") is False or result.get("error"):
                raise RuntimeError(str(result.get("error") or "Tool returned failure")[:300])
            duration = int((monotonic() - started) * 1000)
            from inference.telemetry import tool as record_tool
            record_tool(name, source_type, duration, True, result)
            observation = Observation(
                tool=name,
                success=True,
                observation=result,
                source_type=source_type,
            )
            record = ToolCallRecord(
                tool=name,
                arguments=arguments,
                success=True,
                duration_ms=duration,
                source_type=source_type,
            )
            logger.info(
                "[EduNova AI] Tool execution tool=%s source=%s success=true duration_ms=%s",
                name,
                source_type,
                duration,
            )
            return observation, record
        except asyncio.TimeoutError:
            return self._failure(
                name, arguments, started, "TOOL_TIMEOUT", "Tool execution timed out", source_type
            )
        except Exception as exc:
            code = str(getattr(exc, "error_type", None) or getattr(exc, "code", "TOOL_ERROR"))[:80]
            safe_message = str(exc)[:500] or "Tool execution failed"
            return self._failure(name, arguments, started, code, safe_message, source_type)

    @staticmethod
    def _failure(
        name: str,
        arguments: dict[str, Any],
        started: float,
        code: str,
        message: str,
        source_type: str = "database",
    ) -> tuple[Observation, ToolCallRecord]:
        duration = int((monotonic() - started) * 1000)
        from inference.telemetry import tool as record_tool
        record_tool(name, source_type, duration, False, code=code)
        observation = Observation(
            tool=name,
            success=False,
            observation={"error": message},
            error_code=code,
            source_type=source_type,
        )
        record = ToolCallRecord(
            tool=name,
            arguments=arguments,
            success=False,
            duration_ms=duration,
            error_code=code,
            source_type=source_type,
        )
        return observation, record
