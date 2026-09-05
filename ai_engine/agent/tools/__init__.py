from .base import ToolDefinition, ToolRegistry
from .internal import build_internal_tools
from .utility import build_utility_tools
from .web import build_web_tools, validate_public_url


def build_all_tools(settings) -> list[ToolDefinition]:
    tools: list[ToolDefinition] = []
    tools.extend(build_internal_tools(settings))
    tools.extend(build_utility_tools())
    tools.extend(build_web_tools(settings))
    return tools


__all__ = [
    "ToolDefinition",
    "ToolRegistry",
    "build_all_tools",
    "build_internal_tools",
    "build_utility_tools",
    "build_web_tools",
    "validate_public_url",
]
