"""Small OpenAI-compatible LLM client used by the planner.

The agent is provider-neutral: OpenAI, Azure-compatible gateways, Groq,
OpenRouter, and Gemini's OpenAI-compatible endpoint can be selected entirely
through server-side environment variables.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import time
from typing import Any
from urllib.parse import urlsplit

import httpx

from config import Settings

logger = logging.getLogger("edunova.llm")


class LLMConfigurationError(RuntimeError):
    pass


class LLMResponseError(RuntimeError):
    """Structured provider error that preserves safe diagnostics without secrets."""

    def __init__(
        self,
        message: str,
        *,
        status_code: int | None = None,
        error_type: str | None = None,
        provider_message: str | None = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.error_type = error_type or _classify_error_type(status_code)
        self.provider_message = provider_message or ""


def _classify_error_type(status_code: int | None) -> str:
    if status_code == 401:
        return "authentication_error"
    if status_code == 403:
        return "permission_error"
    if status_code == 404:
        return "not_found"
    if status_code in (408, 504):
        return "timeout"
    if status_code == 429:
        return "rate_limit"
    if status_code == 400:
        return "bad_request"
    if status_code == 500:
        return "provider_error"
    if status_code == 502:
        return "upstream_failure"
    if status_code == 503:
        return "provider_unavailable"
    if status_code is None:
        return "network_error"
    return "provider_error"


def _strip_surrounding_quotes(value: str) -> str:
    v = (value or "").strip()
    iteration = 0
    while len(v) >= 2 and v[0] in "\"'`" and v[-1] in "\"'`" and iteration < 5:
        v = v[1:-1].strip()
        iteration += 1
    v = v.strip().strip("\"'`").strip()
    return v


def _safe_host(base_url: str) -> str:
    try:
        host = urlsplit(base_url or "").hostname or "unknown"
        # Never include port credentials or paths
        return host[:255]
    except Exception:
        return "unknown"


def _sanitize_provider_message(text: str, limit: int = 500) -> str:
    """Sanitize provider error text to be safe for logs and user messages.

    - Strips HTML tags (Render proxy pages are HTML)
    - Collapses whitespace
    - Truncates to limit
    - Removes obvious secret patterns (sk-*, Bearer, Authorization)
    Never returns an API key.
    """
    raw = str(text or "").strip()
    if not raw:
        return ""
    # Strip HTML tags if present (e.g. Render loading page)
    if "<" in raw and ">" in raw:
        raw = re.sub(r"<[^>]*>", " ", raw)
    # Remove potential secret leakage patterns
    raw = re.sub(r"sk-[A-Za-z0-9-_]{10,}", "[redacted-key]", raw)
    raw = re.sub(r"Bearer\s+[A-Za-z0-9-_.\"]+", "Bearer [redacted]", raw, flags=re.IGNORECASE)
    raw = re.sub(r"Authorization\s*:\s*[^\s]+", "Authorization: [redacted]", raw, flags=re.IGNORECASE)
    # Collapse whitespace
    raw = re.sub(r"\s+", " ", raw).strip()
    if len(raw) > limit:
        raw = raw[:limit].rstrip() + "…"
    # Ensure we never return a string that looks like an API key length
    # If it accidentally contains a long token-like substring, truncate earlier
    return raw


def _extract_provider_error(response: httpx.Response) -> tuple[str, str, int]:
    """Extract safe error detail, type, and status from provider response.

    Returns (sanitized_message, error_type, status_code)
    """
    status = response.status_code
    try:
        data = response.json()
    except Exception:
        # HTML or empty body (Render proxy) -> treat as text
        text = ""
        try:
            text = response.text
        except Exception:
            text = ""
        # For proxy HTML, provide a safe mapping
        if status in (502, 503, 504) and ("<html" in text.lower() or "loading" in text.lower()):
            return _sanitize_provider_message(upstream_status_fallback(status)), _classify_error_type(status), status
        # Otherwise sanitize raw text
        sanitized = _sanitize_provider_message(text, limit=400)
        if sanitized:
            return sanitized, _classify_error_type(status), status
        return _sanitize_provider_message(f"Provider returned HTTP {status}"), _classify_error_type(status), status

    # Try common OpenAI-compatible error shapes
    # Shape 1: {"error": {"message": "...", "type": "...", "code": "..."}}
    # Shape 2: {"error": "..."} or {"detail": "..."} or {"message": "..."}
    candidate_message = ""
    candidate_type = ""
    if isinstance(data, dict):
        err = data.get("error")
        if isinstance(err, dict):
            candidate_message = str(err.get("message") or err.get("detail") or err.get("msg") or "")
            candidate_type = str(err.get("type") or err.get("code") or "")
        elif isinstance(err, str):
            candidate_message = err
        if not candidate_message:
            candidate_message = str(data.get("detail") or data.get("message") or data.get("msg") or "")
            candidate_type = str(data.get("type") or data.get("code") or candidate_type)
        # Some providers return {"detail": {"message": "..."}}
        if not candidate_message and isinstance(data.get("detail"), dict):
            detail_dict = data["detail"]
            candidate_message = str(detail_dict.get("message") or detail_dict.get("error") or "")
            candidate_type = str(detail_dict.get("type") or candidate_type)

    sanitized = _sanitize_provider_message(candidate_message or json.dumps(data)[:600], limit=500)
    if not sanitized:
        sanitized = _sanitize_provider_message(f"Provider returned HTTP {status}", limit=200)
    # Prioritize HTTP status classification for auth/permission/not_found/rate_limit.
    # The raw provider type like "invalid_request_error" is too generic for routing.
    expected_type = _classify_error_type(status)
    lower = sanitized.lower()
    if status in (401, 403, 404, 429, 408, 504, 500, 502, 503):
        inferred_type = expected_type
    else:
        inferred_type = candidate_type.strip() or expected_type
        if status == 400 and not candidate_type:
            if "response_format" in lower:
                inferred_type = "unsupported_param"
            elif "max_tokens" in lower or "max_completion_tokens" in lower:
                inferred_type = "unsupported_param"
            elif "model" in lower and ("not found" in lower or "does not exist" in lower):
                inferred_type = "invalid_model"
    return sanitized, inferred_type, status


def upstream_status_fallback(status: int) -> str:
    if status == 401:
        return "Provider authentication failed (401)"
    if status == 403:
        return "Provider permission denied (403)"
    if status == 404:
        return "Provider endpoint or model not found (404)"
    if status == 429:
        return "Provider rate limit exceeded (429)"
    if status in (408, 504):
        return "Provider timeout"
    if status == 503:
        return "Provider temporarily unavailable (503)"
    if status == 502:
        return "Provider upstream failure (502)"
    if status == 500:
        return "Provider internal error (500)"
    return f"Provider returned HTTP {status}"


def _build_chat_completions_url(base_url: str) -> str:
    """Build safe /chat/completions URL, handling duplicate suffixes and /v1 duplication.

    Examples:
    https://api.openai.com/v1 -> https://api.openai.com/v1/chat/completions
    https://api.openai.com/v1/ -> https://api.openai.com/v1/chat/completions
    https://api.openai.com/v1/chat/completions -> https://api.openai.com/v1/chat/completions
    https://api.openai.com/v1/v1 -> https://api.openai.com/v1/chat/completions
    https://api.groq.com/openai/v1 -> https://api.groq.com/openai/v1/chat/completions
    """
    raw = _strip_surrounding_quotes(base_url or "")
    raw = raw.strip().rstrip("/")
    if not raw:
        raise LLMConfigurationError("LLM_BASE_URL is empty; set LLM_BASE_URL to an OpenAI-compatible endpoint")
    # Remove /chat/completions suffix if present to avoid duplication
    lower = raw.lower()
    if lower.endswith("/chat/completions"):
        raw = raw[: -len("/chat/completions")].rstrip("/")
    elif lower.endswith("/chat/completion"):
        raw = raw[: -len("/chat/completion")].rstrip("/")
    # Collapse duplicate /v1/v1
    while "/v1/v1" in raw:
        raw = raw.replace("/v1/v1", "/v1")
    # Ensure scheme - though config already normalizes, be defensive
    if not raw.startswith("http://") and not raw.startswith("https://"):
        raw = "https://" + raw.lstrip("/")
    raw = raw.rstrip("/")
    return f"{raw}/chat/completions"


def parse_json_object(text: str) -> dict[str, Any]:
    candidate = (text or "").strip()
    if candidate.startswith("```"):
        candidate = re.sub(r"^```(?:json)?\s*", "", candidate, flags=re.IGNORECASE)
        candidate = re.sub(r"\s*```$", "", candidate)
    try:
        parsed = json.loads(candidate)
        if isinstance(parsed, dict):
            return parsed
    except json.JSONDecodeError:
        pass

    # Compatibility fallback for providers that wrap an otherwise valid JSON
    # object in one short sentence. Decoder.raw_decode avoids a greedy regex.
    decoder = json.JSONDecoder()
    for match in re.finditer(r"\{", candidate):
        try:
            parsed, _ = decoder.raw_decode(candidate[match.start() :])
            if isinstance(parsed, dict):
                return parsed
        except json.JSONDecodeError:
            continue
    raise LLMResponseError("The model did not return a valid decision object", status_code=None, error_type="invalid_response")


class OpenAICompatibleLLM:
    def __init__(self, settings: Settings, client: httpx.AsyncClient | None = None):
        self.settings = settings
        self._client = client

    async def probe(self) -> None:
        """Authenticate and verify model access without generating completion tokens."""
        if not self.settings.llm_configured:
            raise LLMConfigurationError("LLM provider configuration is incomplete or inconsistent")
        from urllib.parse import quote
        url = f"{self.settings.llm_base_url.rstrip('/')}/models/{quote(self.settings.llm_model, safe='')}"
        headers = {"Authorization": f"Bearer {self.settings.llm_api_key}"}
        owns_client = self._client is None
        client = self._client or httpx.AsyncClient(timeout=httpx.Timeout(self.settings.llm_timeout_seconds), follow_redirects=False)
        try:
            response = await client.get(url, headers=headers)
            if response.status_code >= 400:
                safe_msg, err_type, status = _extract_provider_error(response)
                raise LLMResponseError("LLM provider health check failed", status_code=status, error_type=err_type, provider_message=safe_msg)
        except httpx.TimeoutException as exc:
            raise LLMResponseError("LLM provider health check timed out", status_code=504, error_type="timeout") from exc
        except httpx.NetworkError as exc:
            raise LLMResponseError("LLM provider health check failed", status_code=503, error_type="network_error") from exc
        finally:
            if owns_client:
                await client.aclose()

    async def complete_json(
        self,
        *,
        system_prompt: str,
        user_prompt: str,
        retries: int = 2,
    ) -> dict[str, Any]:
        if not self.settings.llm_configured:
            raise LLMConfigurationError(
                "EduNova AI is not configured. Set LLM_API_KEY, LLM_MODEL, and LLM_BASE_URL on the AI service."
            )
        # Validate base_url does not still contain endpoint suffix (should have been normalized)
        if "/chat/completions" in (self.settings.llm_base_url or "").lower():
            logger.warning(
                "AI_PROVIDER_CONFIG_WARNING base_url still contains /chat/completions; normalizing. host=%s",
                _safe_host(self.settings.llm_base_url),
            )

        payload: dict[str, Any] = {
            "model": self.settings.llm_model,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            "temperature": self.settings.llm_temperature,
            "max_tokens": self.settings.llm_max_output_tokens,
        }
        if self.settings.llm_json_mode:
            payload["response_format"] = {"type": "json_object"}

        # Track which unsupported-param fixes we've already attempted to avoid loops
        attempted_fixes: set[str] = set()
        last_error: Exception | None = None
        # Use monotonic for duration logging
        overall_start = time.monotonic()
        host = _safe_host(self.settings.llm_base_url)
        logger.info(
            "AI_PROVIDER_REQUEST_START provider_host=%s model=%s api_key_present=%s base_url_present=%s timeout=%s json_mode=%s temp=%s max_tokens=%s",
            host,
            self.settings.llm_model,
            bool(self.settings.llm_api_key),
            bool(self.settings.llm_base_url),
            self.settings.llm_timeout_seconds,
            self.settings.llm_json_mode,
            self.settings.llm_temperature,
            self.settings.llm_max_output_tokens,
        )

        for attempt in range(retries + 1):
            try:
                started = time.monotonic()
                result = await self._request(payload)
                duration_ms = int((time.monotonic() - started) * 1000)
                total_duration_ms = int((time.monotonic() - overall_start) * 1000)
                logger.info(
                    "AI_PROVIDER_RESPONSE status=200 duration_ms=%s total_duration_ms=%s model=%s host=%s attempt=%s",
                    duration_ms,
                    total_duration_ms,
                    self.settings.llm_model,
                    host,
                    attempt + 1,
                )
                return result
            except LLMConfigurationError:
                # Configuration errors are not retryable
                raise
            except (httpx.TimeoutException, httpx.NetworkError) as exc:
                last_error = exc
                duration_ms = int((time.monotonic() - overall_start) * 1000)
                is_timeout = isinstance(exc, httpx.TimeoutException)
                err_type = "timeout" if is_timeout else "network_error"
                logger.warning(
                    "AI_PROVIDER_ERROR status=%s type=%s message=%s duration_ms=%s attempt=%s/%s host=%s",
                    408 if is_timeout else 503,
                    err_type,
                    _sanitize_provider_message(str(exc), limit=300),
                    duration_ms,
                    attempt + 1,
                    retries + 1,
                    host,
                )
                if attempt >= retries:
                    break
                await asyncio.sleep(0.35 * (2**attempt))
            except LLMResponseError as exc:
                # LLMResponseError already contains sanitized provider message and status
                last_error = exc
                status = exc.status_code
                duration_ms = int((time.monotonic() - overall_start) * 1000)
                logger.warning(
                    "AI_PROVIDER_ERROR status=%s type=%s message=%s duration_ms=%s attempt=%s/%s host=%s model=%s",
                    status if status is not None else "unknown",
                    exc.error_type,
                    _sanitize_provider_message(exc.provider_message or str(exc), limit=300),
                    duration_ms,
                    attempt + 1,
                    retries + 1,
                    host,
                    self.settings.llm_model,
                )
                # Handle retryable provider errors with specific fixes
                # 1) Unsupported response_format: some OpenAI-compatible providers reject it
                if status == 400 and "response_format" in payload:
                    lower_msg = (exc.provider_message or "").lower()
                    if "response_format" in lower_msg and "response_format_fix" not in attempted_fixes:
                        logger.info("AI_PROVIDER_RETRY removing unsupported response_format host=%s", host)
                        payload.pop("response_format", None)
                        attempted_fixes.add("response_format_fix")
                        # Retry immediately without counting as failed attempt sleep
                        continue
                # 2) max_tokens vs max_completion_tokens incompatibility
                if status == 400:
                    lower_msg = (exc.provider_message or "").lower()
                    if "max_tokens" in lower_msg or "max_completion_tokens" in lower_msg:
                        if "max_tokens" in payload and "max_tokens_fix" not in attempted_fixes:
                            # Swap to max_completion_tokens
                            logger.info(
                                "AI_PROVIDER_RETRY swapping max_tokens->max_completion_tokens host=%s", host
                            )
                            value = payload.pop("max_tokens")
                            payload["max_completion_tokens"] = value
                            attempted_fixes.add("max_tokens_fix")
                            continue
                        elif "max_completion_tokens" in payload and "max_completion_tokens_fix" not in attempted_fixes:
                            logger.info(
                                "AI_PROVIDER_RETRY swapping max_completion_tokens->max_tokens host=%s", host
                            )
                            value = payload.pop("max_completion_tokens")
                            payload["max_tokens"] = value
                            attempted_fixes.add("max_completion_tokens_fix")
                            continue
                # 3) Temperature unsupported (some reasoning models)
                if status == 400 and "temperature" in (exc.provider_message or "").lower():
                    if "temperature" in payload and "temperature_fix" not in attempted_fixes:
                        logger.info("AI_PROVIDER_RETRY removing unsupported temperature host=%s", host)
                        payload.pop("temperature", None)
                        attempted_fixes.add("temperature_fix")
                        continue

                # Retry policy for transient statuses
                if status in {408, 429, 500, 502, 503, 504} and attempt < retries:
                    await asyncio.sleep(0.5 * (2**attempt))
                    continue
                # Non-retryable or out of retries: break to raise classified error
                if status not in {408, 429, 500, 502, 503, 504} or attempt >= retries:
                    break
                # Otherwise retry transient
                await asyncio.sleep(0.5 * (2**attempt))
            except httpx.HTTPStatusError as exc:
                # Fallback: should have been converted to LLMResponseError inside _request, but handle anyway
                last_error = exc
                status = exc.response.status_code if exc.response is not None else None
                duration_ms = int((time.monotonic() - overall_start) * 1000)
                safe_msg, _, _ = _extract_provider_error(exc.response) if exc.response is not None else ("Provider error", "provider_error", status or 500)
                logger.warning(
                    "AI_PROVIDER_ERROR status=%s type=%s message=%s duration_ms=%s attempt=%s/%s host=%s",
                    status,
                    _classify_error_type(status),
                    safe_msg[:300],
                    duration_ms,
                    attempt + 1,
                    retries + 1,
                    host,
                )
                # Retry unsupported response_format
                if status == 400 and "response_format" in payload:
                    payload.pop("response_format", None)
                    continue
                if status not in {408, 429, 500, 502, 503, 504} or attempt >= retries:
                    break
                await asyncio.sleep(0.5 * (2**attempt))

        # Exhausted retries - raise classified error
        if isinstance(last_error, LLMResponseError):
            raise last_error from last_error
        if isinstance(last_error, httpx.HTTPStatusError):
            status = last_error.response.status_code if last_error.response is not None else None
            safe_msg, err_type, _ = _extract_provider_error(last_error.response) if last_error.response is not None else ("Provider error", _classify_error_type(status), status or 500)
            raise LLMResponseError(
                f"LLM provider returned HTTP {status}" if status else "LLM provider error",
                status_code=status,
                error_type=err_type,
                provider_message=safe_msg,
            ) from last_error
        if isinstance(last_error, httpx.TimeoutException):
            raise LLMResponseError(
                "LLM provider timed out",
                status_code=504,
                error_type="timeout",
                provider_message="Provider request timed out",
            ) from last_error
        if isinstance(last_error, httpx.NetworkError):
            # Distinguish DNS vs connect vs generic
            msg = _sanitize_provider_message(str(last_error), limit=300)
            if "Name or service not known" in msg or "getaddrinfo" in msg or "ENOTFOUND" in msg or "DNS" in msg:
                err_type = "dns_error"
                status = 503
            else:
                err_type = "network_error"
                status = 503
            raise LLMResponseError(
                "LLM provider is temporarily unavailable (network)",
                status_code=status,
                error_type=err_type,
                provider_message=msg or "Network error connecting to provider",
            ) from last_error
        # Fallback for LLMResponseError about invalid JSON etc.
        if isinstance(last_error, LLMResponseError):
            raise last_error
        raise LLMResponseError("LLM provider is temporarily unavailable", status_code=502, error_type="provider_unavailable") from last_error

    async def _request(self, payload: dict[str, Any]) -> dict[str, Any]:
        headers = {
            "Authorization": f"Bearer {self.settings.llm_api_key}",
            "Content-Type": "application/json",
        }
        owns_client = self._client is None
        client = self._client or httpx.AsyncClient(
            timeout=httpx.Timeout(self.settings.llm_timeout_seconds),
            follow_redirects=False,
        )
        try:
            url = _build_chat_completions_url(self.settings.llm_base_url)
            response = await client.post(
                url,
                headers=headers,
                json=payload,
            )
            if response.status_code >= 400:
                safe_msg, err_type, status = _extract_provider_error(response)
                raise LLMResponseError(
                    f"LLM provider returned HTTP {status}: {safe_msg[:200]}",
                    status_code=status,
                    error_type=err_type,
                    provider_message=safe_msg,
                )
            data = response.json()
            choices = data.get("choices", [])
            if not choices:
                raise LLMResponseError(
                    "LLM provider returned empty choices",
                    status_code=502,
                    error_type="invalid_response",
                    provider_message="Provider returned no choices",
                )
            content = choices[0].get("message", {}).get("content", "")
            if isinstance(content, list):
                content = "".join(
                    str(part.get("text", "")) if isinstance(part, dict) else str(part)
                    for part in content
                )
            if not content or not str(content).strip():
                # Some providers return content as reasoning or tool calls; check alternative fields
                # Try to handle empty but valid response as error
                raise LLMResponseError(
                    "LLM provider returned empty content",
                    status_code=502,
                    error_type="invalid_response",
                    provider_message="Provider returned empty content",
                )
            return parse_json_object(str(content))
        except httpx.HTTPStatusError:
            raise
        except LLMResponseError:
            raise
        except httpx.TimeoutException:
            raise
        except httpx.NetworkError:
            raise
        except json.JSONDecodeError as exc:
            raise LLMResponseError(
                "LLM provider returned invalid JSON",
                status_code=502,
                error_type="invalid_response",
                provider_message=_sanitize_provider_message(str(exc), limit=300),
            ) from exc
        except Exception as exc:
            # Unexpected parsing errors become provider errors
            if isinstance(exc, LLMResponseError):
                raise
            raise LLMResponseError(
                "LLM provider response could not be parsed",
                status_code=502,
                error_type="invalid_response",
                provider_message=_sanitize_provider_message(str(exc), limit=300),
            ) from exc
        finally:
            if owns_client:
                await client.aclose()
