"""Bounded in-process conversation memory.

The store intentionally keeps only user-visible turns, never private agent
state or tool observations. It can later be replaced by Redis without changing
the agent engine interface.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from time import monotonic
from typing import Any
import re
import uuid

_CONVERSATION_ID = re.compile(r"^[A-Za-z0-9_-]{16,100}$")


@dataclass(slots=True)
class Conversation:
    id: str
    owner_id: str
    messages: list[dict[str, str]] = field(default_factory=list)
    touched_at: float = field(default_factory=monotonic)


class ConversationStore:
    def __init__(self, max_turns: int = 12, ttl_seconds: int = 86_400):
        self.max_messages = max_turns * 2
        self.ttl_seconds = ttl_seconds
        self._items: dict[str, Conversation] = {}

    def get_or_create(self, conversation_id: str | None, owner_id: str) -> Conversation:
        self._prune()
        clean_id = str(conversation_id or "").strip()
        existing = self._items.get(clean_id) if _CONVERSATION_ID.fullmatch(clean_id) else None
        if existing and existing.owner_id == owner_id:
            existing.touched_at = monotonic()
            return existing

        new_id = uuid.uuid4().hex
        conversation = Conversation(id=new_id, owner_id=owner_id)
        self._items[new_id] = conversation
        return conversation

    def append_turn(self, conversation: Conversation, user_message: str, assistant_message: str) -> None:
        conversation.messages.extend(
            [
                {"role": "user", "content": user_message[:12_000]},
                {"role": "assistant", "content": assistant_message[:24_000]},
            ]
        )
        if len(conversation.messages) > self.max_messages:
            del conversation.messages[: len(conversation.messages) - self.max_messages]
        conversation.touched_at = monotonic()

    def _prune(self) -> None:
        cutoff = monotonic() - self.ttl_seconds
        expired = [key for key, item in self._items.items() if item.touched_at < cutoff]
        for key in expired:
            self._items.pop(key, None)
