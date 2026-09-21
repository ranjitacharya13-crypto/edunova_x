// frontend/src/api/authErrors.js
//
// Maps an authentication failure to the message the user sees AND the reason an
// operator needs. This module is deliberately free of Vite/browser globals so it
// can be unit-tested in plain Node (see frontend/tests/authErrors.node.mjs).
//
// The rule: the UI must never turn every failure into "Invalid credentials".
// A malformed request, an unreachable server, a 5xx and a database outage are
// different problems with different fixes, so they get different messages.

export const AUTH_MESSAGES = {
  REQUEST: "Please enter a valid email and password.",
  INVALID_CREDENTIALS: "Invalid email or password.",
  FORBIDDEN: "This account is not allowed to sign in.",
  CONFIG: "The EduNova API is not reachable at the configured address (404). Please contact an administrator.",
  SERVER: "Server error. Please try again.",
  STARTING: "The EduNova server is starting up. Please try again in a moment.",
  NETWORK: "Unable to connect to the EduNova server. Check your connection and try again.",
  UNEXPECTED: "Sign-in failed. Please try again.",
};

/**
 * @param {unknown} error axios error (or anything thrown by the login request)
 * @returns {{ message: string, status: number|null, code: string, serverDetail: string }}
 */
export function describeAuthFailure(error) {
  const response = error && error.response;
  const status = response ? response.status : null;
  const serverDetail = String(
    (response && response.data && (response.data.error || response.data.message)) || ""
  ).trim();

  // No HTTP response at all: offline, DNS failure, CORS rejection, connection
  // refused, or the browser blocked the request. Never "wrong password".
  if (!response) {
    const code = error && error.code === "ECONNABORTED" ? "TIMEOUT" : "NETWORK";
    return {
      message: code === "TIMEOUT" ? AUTH_MESSAGES.STARTING : AUTH_MESSAGES.NETWORK,
      status: null,
      code,
      serverDetail: String((error && error.message) || ""),
    };
  }

  if (status === 400) {
    return { message: AUTH_MESSAGES.REQUEST, status, code: "BAD_REQUEST", serverDetail };
  }
  if (status === 401) {
    return { message: AUTH_MESSAGES.INVALID_CREDENTIALS, status, code: "INVALID_CREDENTIALS", serverDetail };
  }
  if (status === 403) {
    return { message: serverDetail || AUTH_MESSAGES.FORBIDDEN, status, code: "FORBIDDEN", serverDetail };
  }
  if (status === 404) {
    return { message: AUTH_MESSAGES.CONFIG, status, code: "NOT_FOUND", serverDetail };
  }
  if (status === 429) {
    return { message: "Too many sign-in attempts. Please wait a moment and try again.", status, code: "RATE_LIMITED", serverDetail };
  }
  if (status === 503) {
    return { message: serverDetail || AUTH_MESSAGES.STARTING, status, code: "UNAVAILABLE", serverDetail };
  }
  if (status >= 500) {
    return { message: AUTH_MESSAGES.SERVER, status, code: "SERVER_ERROR", serverDetail };
  }
  return { message: serverDetail || AUTH_MESSAGES.UNEXPECTED, status, code: "UNEXPECTED", serverDetail };
}
