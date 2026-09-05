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


def _clean_env_value(raw: str | None) -> str:
    """Strip whitespace and surrounding quotes without exposing secrets."""
    if raw is None:
        return ""
    value = str(raw).strip()
    if not value:
        return ""
    iteration = 0
    while len(value) >= 2 and value[0] in "\"'`" and value[-1] in "\"'`" and iteration < 5:
        inner = value[1:-1].strip()
        if inner == value:
            break
        value = inner
        iteration += 1
    value = value.strip().strip("\"'`").strip()
    return value


def _first_env(*names: str, default: str = "") -> str:
    """Return first non-empty cleaned env value among aliases, else default."""
    for name in names:
        raw = os.getenv(name)
        if raw is None:
            continue
        cleaned = _clean_env_value(raw)
        if cleaned:
            return cleaned
        continue
    return _clean_env_value(default) if default else ""


def _normalize_base_url(raw: str) -> str:
    """Normalize LLM base URL to a safe, deduplicated form."""
    cleaned = _clean_env_value(raw)
    if not cleaned:
        return "https://api.openai.com/v1"

    cleaned = cleaned.strip()
    if " " in cleaned or "\n" in cleaned or "\t" in cleaned:
        cleaned = "".join(cleaned.split())

    cleaned = cleaned.rstrip("/")
    lower = cleaned.lower()
    if lower.endswith("/chat/completions"):
        cleaned = cleaned[: -len("/chat/completions")].rstrip("/")
    elif lower.endswith("/chat/completion"):
        cleaned = cleaned[: -len("/chat/completion")].rstrip("/")

    if "://" in cleaned:
        proto, rest = cleaned.split("://", 1)
        proto = proto.lower() + "://"
        while "//" in rest:
            rest = rest.replace("//", "/")
        cleaned = proto + rest
    else:
        rest = cleaned
        while "//" in rest:
            rest = rest.replace("//", "/")
        cleaned = rest

    while "/v1/v1" in cleaned:
        cleaned = cleaned.replace("/v1/v1", "/v1")
    cleaned = cleaned.rstrip("/")

    if not cleaned.startswith("http://") and not cleaned.startswith("https://"):
        cleaned = "https://" + cleaned.lstrip("/")

    cleaned = cleaned.rstrip("/")
    if cleaned in ("https://", "http://", ""):
        return "https://api.openai.com/v1"
    return cleaned


@dataclass(frozen=True, slots=True)
class Settings:
    llm_api_key: str = ""
    llm_model: str = "gpt-4.1-mini"
    llm_base_url: str = "https://api.openai.com/v1"
    llm_timeout_seconds: int = 60
    llm_max_output_tokens: int = 3000
    llm_temperature: float = 0.2
    llm_json_mode: bool = True

    web_search_api_key: str = ""
    web_search_provider: str = "brave"
    web_search_max_results: int = 5
    web_request_timeout_seconds: int = 10
    web_max_content_length: int = 200_000
    web_max_extracted_chars: int = 45_000
    web_max_redirects: int = 5

    max_agent_iterations: int = 12
    max_tool_calls: int = 15
    max_agent_runtime_seconds: int = 180
    agent_max_context_chars: int = 90_000
    conversation_max_turns: int = 12
    conversation_ttl_seconds: int = 86_400

    ai_internal_token: str = ""
    ai_require_internal_token: bool = False
    app_backend_url: str = "http://127.0.0.1:4000"
    cors_origins: tuple[str, ...] = (
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "https://edunova-x.ranjitacharya13.workers.dev",
    )

    @property
    def llm_configured(self) -> bool:
        return bool(self.llm_api_key and self.llm_model and self.llm_base_url)

    @property
    def search_configured(self) -> bool:
        return bool(self.web_search_api_key and self.web_search_provider)

    def llm_safe_diagnostics(self) -> dict[str, object]:
        host = ""
        try:
            from urllib.parse import urlsplit

            host = urlsplit(self.llm_base_url).hostname or ""
        except Exception:
            host = "invalid"
        api_key_present = bool(self.llm_api_key)
        base_url_has_chat_completions = "/chat/completions" in (self.llm_base_url or "").lower()
        base_url_has_double_v1 = "/v1/v1" in (self.llm_base_url or "")
        base_url_is_localhost = any(
            token in (self.llm_base_url or "").lower()
            for token in ("localhost", "127.0.0.1", "0.0.0.0", "::1")
        )
        return {
            "llm_configured": self.llm_configured,
            "llm_api_key_present": api_key_present,
            "llm_model_present": bool(self.llm_model),
            "llm_model": self.llm_model[:60] if self.llm_model else "",
            "llm_base_url_present": bool(self.llm_base_url),
            "llm_base_url_host": host,
            "llm_base_url_has_chat_completions_suffix": base_url_has_chat_completions,
            "llm_base_url_has_double_v1": base_url_has_double_v1,
            "llm_base_url_is_localhost": base_url_is_localhost,
            "llm_timeout_seconds": self.llm_timeout_seconds,
            "llm_max_output_tokens": self.llm_max_output_tokens,
            "llm_temperature": self.llm_temperature,
            "llm_json_mode": self.llm_json_mode,
        }


def load_settings() -> Settings:
    cors_raw = _clean_env_value(os.getenv("CORS_ORIGIN", ""))
    cors_origins = tuple(
        origin.strip().rstrip("/")
        for origin in cors_raw.split(",")
        if origin.strip()
    ) or (
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "https://edunova-x.ranjitacharya13.workers.dev",
    )

    llm_api_key = _first_env("LLM_API_KEY", "OPENAI_API_KEY", "OPENAI_KEY")
    llm_model = _first_env("LLM_MODEL", "OPENAI_MODEL", default="gpt-4.1-mini")
    llm_model = _clean_env_value(llm_model) or "gpt-4.1-mini"
    raw_base_url = _first_env(
        "LLM_BASE_URL", "OPENAI_BASE_URL", "OPENAI_API_BASE", "OPENAI_API_BASE_URL", default="https://api.openai.com/v1"
    )
    llm_base_url = _normalize_base_url(raw_base_url)

    app_backend_url = _first_env(
        "APP_BACKEND_URL", "EXPRESS_URL", "SERVER_URL", default="http://127.0.0.1:4000"
    ).rstrip("/")

    return Settings(
        llm_api_key=llm_api_key,
        llm_model=llm_model,
        llm_base_url=llm_base_url,
        llm_timeout_seconds=_integer("LLM_REQUEST_TIMEOUT", 60, 5, 180),
        llm_max_output_tokens=_integer("LLM_MAX_OUTPUT_TOKENS", 3000, 256, 12000),
        llm_temperature=_floating("LLM_TEMPERATURE", 0.2, 0.0, 1.0),
        llm_json_mode=_boolean("LLM_JSON_MODE", True),
        web_search_api_key=_clean_env_value(os.getenv("WEB_SEARCH_API_KEY", "")),
        web_search_provider=_clean_env_value(os.getenv("WEB_SEARCH_PROVIDER", "brave")).lower(),
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
        ai_internal_token=_clean_env_value(os.getenv("AI_INTERNAL_TOKEN", "")),
        ai_require_internal_token=_boolean("AI_REQUIRE_INTERNAL_TOKEN", False),
        app_backend_url=app_backend_url,
        cors_origins=cors_origins,
    )
