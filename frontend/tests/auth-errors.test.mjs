// Unit tests for the login error mapper (frontend/src/api/authErrors.mjs).
// Run with: node --test frontend/tests/auth-errors.test.mjs
// (The module is pure ESM with no Vite globals, so plain Node can import it.)
import { test } from "node:test";
import assert from "node:assert/strict";
import { mapLoginError, parseRetryAfterSeconds } from "../src/api/authErrors.mjs";

const httpError = (status, data, headers = {}) => ({
  response: { status, data, headers },
  message: `Request failed with status code ${status}`,
});

test("400 invalid credentials maps to Invalid credentials", () => {
  const mapped = mapLoginError(httpError(400, { error: "Invalid credentials" }));
  assert.equal(mapped.error, "Invalid credentials");
  assert.equal(mapped.status, 400);
  assert.equal(mapped.retryAfterSeconds, 0);
});

test("429 maps to the rate-limit message with retryAfterSeconds from the body", () => {
  const mapped = mapLoginError(
    httpError(429, { error: "Too many sign-in attempts. Please wait a moment and try again.", retryAfterSeconds: 42 })
  );
  assert.match(mapped.error, /Too many sign-in attempts/);
  assert.equal(mapped.status, 429);
  assert.equal(mapped.retryAfterSeconds, 42);
});

test("429 falls back to the Retry-After header when the body omits it", () => {
  const mapped = mapLoginError(httpError(429, {}, { "Retry-After": "30" }));
  assert.equal(mapped.retryAfterSeconds, 30);
});

test("503 maps to temporarily-unavailable, never Invalid credentials", () => {
  const mapped = mapLoginError(httpError(503, { error: "The server is temporarily unavailable. Please try again shortly." }));
  assert.match(mapped.error, /temporarily unavailable/);
  assert.equal(mapped.status, 503);
});

test("500 shows the backend message when present, else a server-error message", () => {
  const withMessage = mapLoginError(httpError(500, { error: "Login failed" }));
  assert.equal(withMessage.error, "Login failed");
  assert.equal(withMessage.status, 500);
  const withoutMessage = mapLoginError(httpError(500, {}));
  assert.match(withoutMessage.error, /went wrong/);
  assert.equal(withoutMessage.status, 500);
});

test("timeout (ECONNABORTED) maps to a retryable timeout message", () => {
  const mapped = mapLoginError({ code: "ECONNABORTED", message: "timeout of 60000ms exceeded" });
  assert.match(mapped.error, /timed out/);
  assert.equal(mapped.status, null);
});

test("network failure (no response) maps to a connection message", () => {
  const mapped = mapLoginError({ code: "ERR_NETWORK", message: "Network Error" });
  assert.match(mapped.error, /Cannot reach the server/);
  assert.equal(mapped.status, null);
});

test("parseRetryAfterSeconds handles delta-seconds and HTTP dates", () => {
  assert.equal(parseRetryAfterSeconds({ "Retry-After": "15" }), 15);
  assert.equal(parseRetryAfterSeconds({}), 0);
  assert.equal(parseRetryAfterSeconds(null), 0);
  const future = new Date(Date.now() + 20_000).toUTCString();
  const seconds = parseRetryAfterSeconds({ "Retry-After": future });
  assert.ok(seconds >= 15 && seconds <= 20, `expected ~20s, got ${seconds}`);
});
