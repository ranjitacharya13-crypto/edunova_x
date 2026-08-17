"""Generic, permission-aware tool registry."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from time import monotonic
from typing import Any

from ..models import Observation, ToolCallRecord

ToolExecutor = Callable[[dict[str, Any]], Awaitable[dict[str, Any]]]


class ToolSchemaError(ValueError):
    code = "INVALID_TOOL_INPUT"


def _validate_input(schema: dict[str, Any], arguments: dict[str, Any]) -> None:
    """Validate the small JSON-Schema subset used by registered tools."""
    if not isinstance(arguments, dict):
        raise ToolSchemaError("Tool input must be an object")
    if not schema or schema.get("type") != "object":
        return
    properties = schema.get("properties", {})
    for required in schema.get("required", []):
        if required not in arguments:
            raise ToolSchemaError(f"Missing required tool input: {required}")
    if schema.get("additionalProperties") is False:
        unexpected = set(arguments) - set(properties)
        if unexpected:
            raise ToolSchemaError(f"Unexpected tool input: {sorted(unexpected)[0]}")
    for name, value in arguments.items():
        rule = properties.get(name)
        if not isinstance(rule, dict):
            continue
        expected = rule.get("type")
        if expected == "string" and not isinstance(value, str):
            raise ToolSchemaError(f"{name} must be a string")
        if expected == "integer" and (not isinstance(value, int) or isinstance(value, bool)):
            raise ToolSchemaError(f"{name} must be an integer")
        if isinstance(value, str) and len(value) > int(rule.get("maxLength", len(value))):
            raise ToolSchemaError(f"{name} is too long")
        if isinstance(value, int) and not isinstance(value, bool):
            if "minimum" in rule and value < rule["minimum"]:
                raise ToolSchemaError(f"{name} is below the minimum")
            if "maximum" in rule and value > rule["maximum"]:
                raise ToolSchemaError(f"{name} exceeds the maximum")


@dataclass(frozen=True, slots=True)
class ToolDefinition:
    name: str
    description: str
    input_schema: dict[str, Any]
    executor: ToolExecutor
    permission: str
    timeout_seconds: int
    result_format: str

    def agent_spec(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "description": self.description,
            "inputSchema": self.input_schema,
            "permission": self.permission,
            "timeoutSeconds": self.timeout_seconds,
            "resultFormat": self.result_format,
        }


class ToolRegistry:
    def __init__(self, allowed_permissions: set[str] | None = None):
        self._tools: dict[str, ToolDefinition] = {}
        self.allowed_permissions = allowed_permissions or {"READ_EXTERNAL"}

    def register(self, tool: ToolDefinition) -> None:
        if not tool.name or tool.name in self._tools:
            raise ValueError(f"Tool already registered or invalid: {tool.name!r}")
        self._tools[tool.name] = tool

    def specs(self) -> list[dict[str, Any]]:
        return [tool.agent_spec() for tool in self._tools.values()]

    def has(self, name: str) -> bool:
        return name in self._tools

    async def execute(
        self, name: str, arguments: dict[str, Any]
    ) -> tuple[Observation, ToolCallRecord]:
        started = monotonic()
        tool = self._tools.get(name)
        if not tool:
            return self._failure(name, arguments, started, "UNKNOWN_TOOL", "Requested tool is not registered")
        if tool.permission not in self.allowed_permissions:
            return self._failure(
                name,
                arguments,
                started,
                "PERMISSION_DENIED",
                f"Permission {tool.permission} requires explicit approval",
            )

        try:
            _validate_input(tool.input_schema, arguments)
            result = await asyncio.wait_for(
                tool.executor(arguments), timeout=tool.timeout_seconds
            )
            duration = int((monotonic() - started) * 1000)
            observation = Observation(
                tool=name,
                success=True,
                observation=result,
            )
            record = ToolCallRecord(
                tool=name,
                arguments=arguments,
                success=True,
                duration_ms=duration,
            )
            return observation, record
        except asyncio.TimeoutError:
            return self._failure(
                name, arguments, started, "TOOL_TIMEOUT", "Tool execution timed out"
            )
        except Exception as exc:  # Tool failures are observations, not agent crashes.
            code = str(getattr(exc, "code", "TOOL_ERROR"))[:80]
            safe_message = str(exc)[:500] or "Tool execution failed"
            return self._failure(name, arguments, started, code, safe_message)

    @staticmethod
    def _failure(
        name: str,
        arguments: dict[str, Any],
        started: float,
        code: str,
        message: str,
    ) -> tuple[Observation, ToolCallRecord]:
        duration = int((monotonic() - started) * 1000)
        observation = Observation(
            tool=name,
            success=False,
            observation={"error": message},
            error_code=code,
        )
        record = ToolCallRecord(
            tool=name,
            arguments=arguments,
            success=False,
            duration_ms=duration,
            error_code=code,
        )
        return observation, record
