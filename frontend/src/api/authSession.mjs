// frontend/src/api/authSession.mjs
//
// Pure ESM helpers for JWT expiration inspection, login response validation,
// and resilient token storage. Free of Vite/DOM-only globals so it can be
// tested directly with `node --test`.

const TOKEN_KEY = "token";

function decodeBase64Url(segment) {
  const normalized = String(segment).replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  if (typeof atob === "function") {
    return atob(padded);
  }
  if (typeof Buffer !== "undefined") {
    return Buffer.from(padded, "base64").toString("utf8");
  }
  return "";
}

// Safely decode the JSON payload of a 3-segment JWT without verifying its
// cryptographic signature (signature verification always happens on the server).
// Returns null if `token` is not a well-formed 3-segment JWT.
export function decodeJwtPayload(token) {
  if (typeof token !== "string") return null;
  const parts = token.trim().split(".");
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) return null;
  try {
    const json = decodeBase64Url(parts[1]);
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// Returns true when `token` is empty or carries an `exp` claim that has
// already elapsed (within `skewSeconds`). Opaque non-JWT test fixtures without
// 3 segments return false so browser test fixtures continue to work while the
// server remains authoritative.
export function isJwtExpired(token, nowMs = Date.now(), skewSeconds = 5) {
  if (typeof token !== "string" || !token.trim()) return true;
  const payload = decodeJwtPayload(token);
  if (!payload) return false;
  if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) return false;
  return payload.exp * 1000 <= nowMs + skewSeconds * 1000;
}

// Validate the HTTP 200 payload returned by POST /api/auth/login so an HTML
// fallback page or malformed proxy payload can never leave the login UI silent.
export function validateLoginResponse(data, nowMs = Date.now()) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return {
      ok: false,
      error: "Unexpected response from the authentication server. Please try again.",
      status: null,
      retryAfterSeconds: 0,
    };
  }

  if (data.error) {
    const message =
      typeof data.error === "string"
        ? data.error.trim()
        : typeof data.error?.message === "string"
          ? data.error.message.trim()
          : "";
    return {
      ok: false,
      error: message || "Sign-in failed. Please try again.",
      status: Number(data.status) || null,
      retryAfterSeconds: Number(data.retryAfterSeconds) > 0 ? Number(data.retryAfterSeconds) : 0,
      bucket: data.bucket || null,
    };
  }

  const token = typeof data.token === "string" ? data.token.trim() : "";
  const user = data.user && typeof data.user === "object" ? data.user : null;

  if (!token || !user) {
    return {
      ok: false,
      error: "Unexpected response from the authentication server. Please try again.",
      status: null,
      retryAfterSeconds: 0,
    };
  }

  if (isJwtExpired(token, nowMs, 0)) {
    return {
      ok: false,
      error: "Received an expired session token. Please sign in again.",
      status: 401,
      retryAfterSeconds: 0,
    };
  }

  return { ok: true, token, user };
}

function defaultStorage() {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

export function getStoredToken(storage = defaultStorage()) {
  if (!storage) return "";
  try {
    return String(storage.getItem(TOKEN_KEY) || "").trim();
  } catch {
    return "";
  }
}

export function setStoredToken(token, storage = defaultStorage()) {
  if (!storage) return false;
  try {
    storage.setItem(TOKEN_KEY, String(token || "").trim());
    return true;
  } catch {
    return false;
  }
}

export function clearStoredToken(storage = defaultStorage()) {
  if (!storage) return false;
  try {
    storage.removeItem(TOKEN_KEY);
    return true;
  } catch {
    return false;
  }
}
