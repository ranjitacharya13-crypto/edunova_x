"""Safe, high-level agent observability events.

Event payloads intentionally exclude prompts, private reasoning, page content,
and complete tool inputs.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any
import inspect
import json
import logging

logger = logging.getLogger("edunova.agent")
EventCallback = Callable[[dict[str, Any]], Awaitable[None] | None]

STATUS_MESSAGES = {
    "agent.started": "Understanding your question...",
    "agent.goal_identified": "Understanding your learning goal...",
    "agent.planning": "Deciding the best next step...",
    "agent.replanning": "Evaluating what I found...",
    "agent.verification_started": "Checking reliable sources...",
    "agent.response_generated": "Preparing your answer...",
    "agent.goal_completed": "Answer ready.",
}

TOOL_STATUS_MESSAGES = {
    "web_search": "Researching current information...",
    "open_url": "Reviewing a relevant source...",
    "extract_webpage": "Extracting the important details...",
}


@dataclass(slots=True)
class EventEmitter:
    session_id: str
    callback: EventCallback | None = None

    async def emit(self, event_type: str, **metadata: Any) -> None:
        safe_metadata = {
            key: value
            for key, value in metadata.items()
            if key in {"iteration", "tool", "success", "durationMs", "confidence"}
        }
        event = {
            "type": "status",
            "event": event_type,
            "message": self._message(event_type, safe_metadata.get("tool")),
            **safe_metadata,
        }
        logger.info(
            json.dumps(
                {
                    "event": event_type,
                    "sessionId": self.session_id,
                    **safe_metadata,
                },
                separators=(",", ":"),
            )
        )
        if self.callback:
            result = self.callback(event)
            if inspect.isawaitable(result):
                await result

    @staticmethod
    def _message(event_type: str, tool: str | None) -> str:
        if event_type in {"agent.tool_selected", "agent.tool_started"}:
            return TOOL_STATUS_MESSAGES.get(tool or "", "Using a research tool...")
        if event_type == "agent.tool_completed":
            return "Reviewing the result..."
        if event_type == "agent.observation_received":
            return "Evaluating the evidence..."
        return STATUS_MESSAGES.get(event_type, "Working on your request...")
