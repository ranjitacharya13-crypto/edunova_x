"""Environment-backed configuration for the EduNova agent.

All limits are server-side and bounded again here so an accidental environment
value cannot turn the agent into an unbounded worker.
"""

from __future__ import annotations

from dataclasses import dataclass
import os


def _integer(name: str, default: int, minimum: int, maximum: int) -> int:
    try:
        value = int(os.getenv(name, str(default)))
    except (TypeError, ValueError):
        value = default
    return max(minimum, min(value, maximum))


def _floating(name: str, default: float, minimum: float, maximum: float) -> float:
    try:
        value = float(os.getenv(name, str(default)))
    except (TypeError, ValueError):
        value = default
    return max(minimum, min(value, maximum))


def _boolean(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True, slots=True)
class Settings:
    llm_api_key: str
    llm_model: str
    llm_base_url: str
    llm_timeout_seconds: int
    llm_max_output_tokens: int
    llm_temperature: float
    llm_json_mode: bool

    web_search_api_key: str
    web_search_provider: str
    web_search_max_results: int
    web_request_timeout_seconds: int
    web_max_content_length: int
    web_max_extracted_chars: int
    web_max_redirects: int

    max_agent_iterations: int
    max_tool_calls: int
    max_agent_runtime_seconds: int
    agent_max_context_chars: int
    conversation_max_turns: int
    conversation_ttl_seconds: int

    ai_internal_token: str
    ai_require_internal_token: bool
    cors_origins: tuple[str, ...]

    @property
    def llm_configured(self) -> bool:
        return bool(self.llm_api_key and self.llm_model and self.llm_base_url)

    @property
    def search_configured(self) -> bool:
        return bool(self.web_search_api_key and self.web_search_provider)


def load_settings() -> Settings:
    cors_raw = os.getenv("CORS_ORIGIN", "").strip()
    cors_origins = tuple(
        origin.strip().rstrip("/")
        for origin in cors_raw.split(",")
        if origin.strip()
    ) or (
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "https://edunova-x.ranjitacharya13.workers.dev",
    )

    return Settings(
        llm_api_key=os.getenv("LLM_API_KEY", "").strip(),
        llm_model=os.getenv("LLM_MODEL", "gpt-4.1-mini").strip(),
        llm_base_url=os.getenv("LLM_BASE_URL", "https://api.openai.com/v1").strip().rstrip("/"),
        llm_timeout_seconds=_integer("LLM_REQUEST_TIMEOUT", 60, 5, 180),
        llm_max_output_tokens=_integer("LLM_MAX_OUTPUT_TOKENS", 3000, 256, 12000),
        llm_temperature=_floating("LLM_TEMPERATURE", 0.2, 0.0, 1.0),
        llm_json_mode=_boolean("LLM_JSON_MODE", True),
        web_search_api_key=os.getenv("WEB_SEARCH_API_KEY", "").strip(),
        web_search_provider=os.getenv("WEB_SEARCH_PROVIDER", "brave").strip().lower(),
        web_search_max_results=_integer("WEB_SEARCH_MAX_RESULTS", 5, 1, 10),
        web_request_timeout_seconds=_integer("WEB_REQUEST_TIMEOUT", 10, 2, 30),
        web_max_content_length=_integer("WEB_MAX_CONTENT_LENGTH", 200_000, 10_000, 1_000_000),
        web_max_extracted_chars=_integer("WEB_MAX_EXTRACTED_CHARS", 45_000, 4_000, 100_000),
        web_max_redirects=_integer("WEB_MAX_REDIRECTS", 5, 0, 10),
        max_agent_iterations=_integer("MAX_AGENT_ITERATIONS", 12, 1, 30),
        max_tool_calls=_integer("MAX_TOOL_CALLS", 15, 0, 40),
        max_agent_runtime_seconds=_integer("MAX_AGENT_RUNTIME_SECONDS", 180, 30, 900),
        agent_max_context_chars=_integer("AGENT_MAX_CONTEXT_CHARS", 90_000, 10_000, 250_000),
        conversation_max_turns=_integer("CONVERSATION_MAX_TURNS", 12, 2, 30),
        conversation_ttl_seconds=_integer("CONVERSATION_TTL_SECONDS", 86_400, 300, 604_800),
        ai_internal_token=os.getenv("AI_INTERNAL_TOKEN", "").strip(),
        ai_require_internal_token=_boolean("AI_REQUIRE_INTERNAL_TOKEN", False),
        cors_origins=cors_origins,
    )
