// frontend/src/api/authErrors.mjs
//
// Pure mapping from login API failures to user-facing messages.
//
// This module has NO imports and NO Vite-specific globals on purpose, so it
// can be unit-tested directly with `node --test` (see
// frontend/tests/auth-errors.test.mjs). `api.js` uses it for loginUser.
//
// The old behaviour collapsed EVERY failure (wrong password, rate limit,
// server down, network offline, timeout) into "Invalid credentials", which
// hid the real cause and made the stuck "Signing in..." button impossible
// to diagnose. Each failure class now gets an accurate, retryable message.

export const LOGIN_MESSAGES = {
  INVALID_CREDENTIALS: "Invalid credentials",
  RATE_LIMITED: "Too many sign-in attempts. Please wait a moment and try again.",
  UNAVAILABLE: "The server is temporarily unavailable. Please try again shortly.",
  SERVER_ERROR: "Something went wrong on the server. Please try again later.",
  TIMEOUT: "The request timed out. The server may be starting up — please try again.",
  NETWORK: "Cannot reach the server. Check your connection and try again.",
  GENERIC: "Something went wrong. Please try again.",
};

// Parse a Retry-After header value (delta-seconds or HTTP-date) into
// seconds from now. Returns 0 when absent/unparseable.
export function parseRetryAfterSeconds(headers) {
  if (!headers) return 0;
  const get = (name) => {
    if (typeof headers.get === "function") return headers.get(name);
    return headers[name] || headers[name.toLowerCase()];
  };
  const raw = get("Retry-After") || get("retry-after");
  if (raw === null || raw === undefined || raw === "") return 0;
  const text = String(raw).trim();
  if (/^\d+$/.test(text)) return Math.max(0, Number(text));
  const when = Date.parse(text);
  if (!Number.isNaN(when)) return Math.max(0, Math.ceil((when - Date.now()) / 1000));
  return 0;
}

// Map an axios error (or any thrown value) from POST /api/auth/login to
// { error, status, retryAfterSeconds }. Never throws.
export function mapLoginError(err) {
  const response = err?.response;
  const status = response?.status ?? null;
  const body = response?.data;
  const backendMessage =
    typeof body?.error === "string" && body.error.trim() ? body.error.trim() : "";

  if (!response) {
    // No HTTP response at all: timeout, DNS, offline, CORS, or the backend
    // never answered (Render free-tier cold start). Never "Invalid
    // credentials" — the credentials were never even checked.
    if (err?.code === "ECONNABORTED" || /timeout/i.test(String(err?.message || ""))) {
      return { error: LOGIN_MESSAGES.TIMEOUT, status: null, retryAfterSeconds: 0 };
    }
    return { error: LOGIN_MESSAGES.NETWORK, status: null, retryAfterSeconds: 0 };
  }

  if (status === 429) {
    const retryAfterSeconds =
      Number(body?.retryAfterSeconds) > 0
        ? Number(body.retryAfterSeconds)
        : parseRetryAfterSeconds(response.headers);
    return {
      error: backendMessage || LOGIN_MESSAGES.RATE_LIMITED,
      status,
      retryAfterSeconds,
    };
  }

  if (status === 400 || status === 401) {
    // Backend already returns the generic "Invalid credentials" for both
    // unknown accounts and wrong passwords (no enumeration oracle).
    return {
      error: backendMessage || LOGIN_MESSAGES.INVALID_CREDENTIALS,
      status,
      retryAfterSeconds: 0,
    };
  }

  if (status === 403) {
    return { error: backendMessage || "Access denied.", status, retryAfterSeconds: 0 };
  }

  if (status === 503) {
    return { error: backendMessage || LOGIN_MESSAGES.UNAVAILABLE, status, retryAfterSeconds: 0 };
  }

  if (status >= 500) {
    return { error: backendMessage || LOGIN_MESSAGES.SERVER_ERROR, status, retryAfterSeconds: 0 };
  }

  return { error: backendMessage || LOGIN_MESSAGES.GENERIC, status, retryAfterSeconds: 0 };
}
