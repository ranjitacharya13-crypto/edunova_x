"""Utility tools for the EduNova AI Agent (Safe math, date/time)."""

from __future__ import annotations

import ast
from datetime import datetime, timezone
import math
import operator
from typing import Any

from .base import ToolDefinition, ToolSchemaError

_SAFE_OPERATORS = {
    ast.Add: operator.add,
    ast.Sub: operator.sub,
    ast.Mult: operator.mul,
    ast.Div: operator.truediv,
    ast.FloorDiv: operator.floordiv,
    ast.Mod: operator.mod,
    ast.Pow: operator.pow,
    ast.USub: operator.neg,
    ast.UAdd: operator.pos,
}

_SAFE_FUNCTIONS = {
    "sqrt": math.sqrt,
    "sin": math.sin,
    "cos": math.cos,
    "tan": math.tan,
    "log": math.log,
    "log10": math.log10,
    "exp": math.exp,
    "abs": abs,
    "round": round,
    "floor": math.floor,
    "ceil": math.ceil,
}

_SAFE_CONSTANTS = {
    "pi": math.pi,
    "e": math.e,
}


def _eval_node(node: ast.AST) -> Any:
    if isinstance(node, ast.Expression):
        return _eval_node(node.body)
    if isinstance(node, ast.Constant):
        if isinstance(node.value, (int, float)):
            return node.value
        raise ToolSchemaError("Only numeric constants are allowed in calculation")
    if isinstance(node, ast.Name):
        if node.id in _SAFE_CONSTANTS:
            return _SAFE_CONSTANTS[node.id]
        raise ToolSchemaError(f"Unknown constant: {node.id}")
    if isinstance(node, ast.BinOp):
        left = _eval_node(node.left)
        right = _eval_node(node.right)
        op_type = type(node.op)
        if op_type in _SAFE_OPERATORS:
            return _SAFE_OPERATORS[op_type](left, right)
        raise ToolSchemaError(f"Unsupported operator: {op_type.__name__}")
    if isinstance(node, ast.UnaryOp):
        operand = _eval_node(node.operand)
        op_type = type(node.op)
        if op_type in _SAFE_OPERATORS:
            return _SAFE_OPERATORS[op_type](operand)
        raise ToolSchemaError(f"Unsupported unary operator: {op_type.__name__}")
    if isinstance(node, ast.Call):
        if isinstance(node.func, ast.Name) and node.func.id in _SAFE_FUNCTIONS:
            args = [_eval_node(arg) for arg in node.args]
            return _SAFE_FUNCTIONS[node.func.id](*args)
        raise ToolSchemaError("Unsupported function in calculation")
    raise ToolSchemaError(f"Unsupported expression element: {type(node).__name__}")


def safe_calculate(expression: str) -> float | int:
    expr = str(expression or "").strip()
    if not expr:
        raise ToolSchemaError("Expression cannot be empty")
    if len(expr) > 200:
        raise ToolSchemaError("Expression is too long")
    try:
        tree = ast.parse(expr, mode="eval")
        return _eval_node(tree)
    except Exception as exc:
        raise ToolSchemaError(f"Invalid mathematical expression: {exc}") from exc


class UtilityTools:
    @staticmethod
    async def calculator(arguments: dict[str, Any]) -> dict[str, Any]:
        expr = str(arguments.get("expression") or "").strip()
        result = safe_calculate(expr)
        return {
            "expression": expr,
            "result": result,
            "formatted": str(result),
        }

    @staticmethod
    async def get_current_datetime(arguments: dict[str, Any] | None = None) -> dict[str, Any]:
        now = datetime.now(timezone.utc)
        days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
        return {
            "iso": now.isoformat(),
            "date": now.strftime("%Y-%m-%d"),
            "timeUtc": now.strftime("%H:%M:%S UTC"),
            "dayOfWeek": days[now.weekday()],
            "year": now.year,
            "month": now.strftime("%B"),
        }


def build_utility_tools() -> list[ToolDefinition]:
    return [
        ToolDefinition(
            name="calculator",
            description="Perform exact calculations for arithmetic, formulas, percentages, and scientific math.",
            input_schema={
                "type": "object",
                "properties": {
                    "expression": {"type": "string", "maxLength": 200},
                },
                "required": ["expression"],
                "additionalProperties": False,
            },
            executor=UtilityTools.calculator,
            permission="UTILITY",
            category="UTILITY",
            timeout_seconds=5,
            result_format="Computed numeric result",
        ),
        ToolDefinition(
            name="get_current_datetime",
            description="Get the current date, time, and day of the week to resolve time-sensitive queries.",
            input_schema={"type": "object", "properties": {}, "additionalProperties": False},
            executor=UtilityTools.get_current_datetime,
            permission="UTILITY",
            category="UTILITY",
            timeout_seconds=5,
            result_format="Current date, time UTC, and day of the week",
        ),
    ]
