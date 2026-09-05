"""Internal data models for the Unified Data-Aware EduNova AI Agent.

These objects are deliberately separate from API response models. The private
agent state is never serialized directly to a browser.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any
import uuid


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass(slots=True)
class Source:
    id: str
    url: str = ""
    title: str = ""
    domain: str = ""
    snippet: str = ""
    source_type: str = "external"  # "database" | "external" | "conversation" | "model" | "utility" | "application"
    freshness: str = "CURRENT"  # "STATIC" | "CURRENT" | "USER-SPECIFIC" | "EXTERNAL-CURRENT"
    published_date: str | None = None
    discovered_by: set[str] = field(default_factory=set)

    def public(self) -> dict[str, Any]:
        result: dict[str, Any] = {
            "id": self.id,
            "title": self.title or self.domain or self.url,
            "url": self.url,
            "domain": self.domain,
            "sourceType": self.source_type,
            "freshness": self.freshness,
        }
        if self.snippet:
            result["snippet"] = self.snippet[:500]
        if self.published_date:
            result["publishedDate"] = self.published_date
        return result


@dataclass(slots=True)
class Observation:
    tool: str
    success: bool
    observation: dict[str, Any]
    source_type: str = "database"
    useful: bool | None = None
    error_code: str | None = None
    created_at: str = field(default_factory=utc_now)


@dataclass(slots=True)
class ToolCallRecord:
    tool: str
    arguments: dict[str, Any]
    success: bool
    duration_ms: int
    source_type: str = "database"
    error_code: str | None = None
    created_at: str = field(default_factory=utc_now)


@dataclass(slots=True)
class AgentState:
    goal: str
    conversation: list[dict[str, str]]
    session_id: str = field(default_factory=lambda: str(uuid.uuid4()))
    user_id: str = "authenticated-user"
    user_role: str = "student"
    user_name: str = "Student"
    user_email: str = ""
    current_understanding: str = ""
    goal_type: str = "question"
    known_facts: list[str] = field(default_factory=list)
    unknowns: list[str] = field(default_factory=list)
    assumptions: list[str] = field(default_factory=list)
    observations: list[Observation] = field(default_factory=list)
    sources: dict[str, Source] = field(default_factory=dict)
    internal_sources: list[dict[str, Any]] = field(default_factory=list)
    executed_actions: list[dict[str, Any]] = field(default_factory=list)
    tool_history: list[ToolCallRecord] = field(default_factory=list)
    plan: list[str] = field(default_factory=list)
    completed_objectives: list[str] = field(default_factory=list)
    pending_objectives: list[str] = field(default_factory=list)
    confidence: str = "LOW"
    iteration_count: int = 0
    tool_call_count: int = 0
    goal_completed: bool = False
    used_web: bool = False
    used_internal_db: bool = False
    final_answer: str = ""


@dataclass(slots=True)
class AgentAction:
    action: str
    tool_name: str | None = None
    tool_input: dict[str, Any] = field(default_factory=dict)
    answer: str = ""
    status: str = ""
    state_update: dict[str, Any] = field(default_factory=dict)


@dataclass(slots=True)
class AgentResult:
    success: bool
    message: str
    sources: list[dict[str, Any]]
    used_web: bool
    agent_status: str
    conversation_id: str
    used_internal_db: bool = False
    internal_sources: list[dict[str, Any]] = field(default_factory=list)
    actions: list[dict[str, Any]] = field(default_factory=list)
    limit_reached: bool = False

    def public(self) -> dict[str, Any]:
        return {
            "success": self.success,
            "message": self.message,
            "reply": self.message,
            "sources": self.sources,
            "usedWeb": self.used_web,
            "usedInternalDb": self.used_internal_db,
            "internalSources": self.internal_sources,
            "actions": self.actions,
            "agentStatus": self.agent_status,
            "conversationId": self.conversation_id,
            "limitReached": self.limit_reached,
        }
