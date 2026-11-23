// Unit tests for frontend auth error mapping, JWT session validation, and
// Cloudflare Worker client-IP proxy forwarding.
// Run with: node --test frontend/tests/auth-errors.test.mjs
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mapLoginError, parseRetryAfterSeconds } from "../src/api/authErrors.mjs";
import {
  clearStoredToken,
  decodeJwtPayload,
  getStoredToken,
  isJwtExpired,
  setStoredToken,
  validateLoginResponse,
} from "../src/api/authSession.mjs";
import workerImport from "../public/_worker.js";
const worker = workerImport?.default || workerImport;

const httpError = (status, data, headers = {}) => ({
  response: { status, data, headers },
  message: `Request failed with status code ${status}`,
});

function makeJwt(payload) {
  const b64 = (obj) =>
    Buffer.from(JSON.stringify(obj)).toString("base64url");
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64(payload)}.signature`;
}

describe("mapLoginError — HTTP statuses & network failures", () => {
  test("401 invalid credentials maps cleanly", () => {
    const mapped = mapLoginError(httpError(401, { error: "Invalid credentials" }));
    assert.equal(mapped.error, "Invalid credentials");
    assert.equal(mapped.status, 401);
    assert.equal(mapped.retryAfterSeconds, 0);
  });

  test("403 suspended account maps to clear suspension message", () => {
    const mapped = mapLoginError(
      httpError(403, { error: "Your account has been suspended. Please contact an administrator." })
    );
    assert.match(mapped.error, /suspended/);
    assert.equal(mapped.status, 403);
  });

  test("429 maps to rate-limit message with retryAfterSeconds and bucket", () => {
    const mapped = mapLoginError(
      httpError(429, {
        error: "Too many sign-in attempts. Please wait a moment and try again.",
        retryAfterSeconds: 42,
        bucket: "account",
      })
    );
    assert.match(mapped.error, /Too many sign-in attempts/);
    assert.equal(mapped.status, 429);
    assert.equal(mapped.retryAfterSeconds, 42);
    assert.equal(mapped.bucket, "account");
  });

  test("429 falls back to Retry-After header when body omits retryAfterSeconds", () => {
    const mapped = mapLoginError(httpError(429, {}, { "Retry-After": "30" }));
    assert.equal(mapped.retryAfterSeconds, 30);
  });

  test("502/503/504 map to temporarily-unavailable, never Invalid credentials", () => {
    for (const status of [502, 503, 504]) {
      const mapped = mapLoginError(httpError(status, {}));
      assert.match(mapped.error, /temporarily unavailable/);
      assert.equal(mapped.status, status);
    }
  });

  test("500 strips raw HTML proxy pages and returns safe server-error message", () => {
    const htmlPage = mapLoginError(httpError(500, { error: "<html><body>500 Error</body></html>" }));
    assert.match(htmlPage.error, /went wrong on the server/);
    assert.ok(!htmlPage.error.includes("<html"));
  });

  test("timeout (ECONNABORTED) maps to retryable timeout message", () => {
    const mapped = mapLoginError({
      code: "ECONNABORTED",
      message: "timeout of 30000ms exceeded",
    });
    assert.match(mapped.error, /timed out/);
    assert.equal(mapped.status, null);
  });

  test("backend unavailable / network error maps to connection message", () => {
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
});

describe("authSession — JWT expiration & login response validation", () => {
  test("decodeJwtPayload and isJwtExpired detect valid vs expired JWTs", () => {
    const nowMs = 1_700_000_000_000;
    const futureJwt = makeJwt({ id: "u1", exp: Math.floor(nowMs / 1000) + 3600 });
    const expiredJwt = makeJwt({ id: "u1", exp: Math.floor(nowMs / 1000) - 60 });

    assert.equal(decodeJwtPayload(futureJwt)?.id, "u1");
    assert.equal(isJwtExpired(futureJwt, nowMs), false);
    assert.equal(isJwtExpired(expiredJwt, nowMs), true);
    assert.equal(isJwtExpired("", nowMs), true);
    // Opaque test fixture token is allowed client-side so browser fixtures work
    assert.equal(isJwtExpired("explicit-browser-test-token", nowMs), false);
  });

  test("validateLoginResponse rejects HTML 200 fallback pages and expired tokens", () => {
    const nowMs = 1_700_000_000_000;
    const html200 = validateLoginResponse("<!doctype html><html></html>", nowMs);
    assert.equal(html200.ok, false);
    assert.match(html200.error, /Unexpected response/);

    const expiredToken = makeJwt({ id: "u1", exp: Math.floor(nowMs / 1000) - 10 });
    const expiredRes = validateLoginResponse(
      { token: expiredToken, user: { id: "u1", role: "student" } },
      nowMs
    );
    assert.equal(expiredRes.ok, false);
    assert.match(expiredRes.error, /expired/);

    const validToken = makeJwt({ id: "u1", exp: Math.floor(nowMs / 1000) + 3600 });
    const validRes = validateLoginResponse(
      { token: validToken, user: { id: "u1", role: "student" } },
      nowMs
    );
    assert.equal(validRes.ok, true);
    assert.equal(validRes.token, validToken);
  });

  test("storage helpers never throw even when localStorage throws SecurityError", () => {
    const brokenStorage = {
      getItem() { throw new Error("SecurityError"); },
      setItem() { throw new Error("QuotaExceededError"); },
      removeItem() { throw new Error("SecurityError"); },
    };
    assert.equal(getStoredToken(brokenStorage), "");
    assert.equal(setStoredToken("tok", brokenStorage), false);
    assert.equal(clearStoredToken(brokenStorage), false);
  });
});

describe("Cloudflare Worker (_worker.js) — client IP forwarding & anti-spoofing", () => {
  test("strips forged headers, forwards CF-Connecting-IP via X-EduNova-Client-IP, and handles unreachable backend", async () => {
    const originalFetch = globalThis.fetch;
    let capturedRequest = null;

    globalThis.fetch = async (req) => {
      capturedRequest = req;
      return Response.json({ token: "ok", user: { id: "1" } }, { status: 200 });
    };

    try {
      const incoming = new Request(
        "https://edunova-x.ranjitacharya13.workers.dev/api/auth/login",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "CF-Connecting-IP": "49.37.88.99",
            "X-Forwarded-For": "1.2.3.4",
            "X-EduNova-Client-IP": "9.9.9.9",
            "X-Proxy-Secret": "attacker-forged-secret",
          },
          body: JSON.stringify({ email: "student@edunova.demo", password: "Student@12345" }),
        }
      );

      const res = await worker.fetch(incoming, {
        BACKEND_URL: "https://edunova-api-y3rx.onrender.com",
        PROXY_SECRET: "real-worker-secret",
      });

      assert.equal(res.status, 200);
      assert.ok(capturedRequest);
      assert.equal(capturedRequest.headers.get("X-EduNova-Client-IP"), "49.37.88.99");
      assert.equal(capturedRequest.headers.get("X-Forwarded-For"), "49.37.88.99");
      assert.equal(capturedRequest.headers.get("X-Proxy-Secret"), "real-worker-secret");

      // Backend unreachable -> clean 502 JSON error (never hangs)
      globalThis.fetch = async () => {
        throw new Error("ECONNREFUSED");
      };
      const downRes = await worker.fetch(
        new Request("https://edunova-x.ranjitacharya13.workers.dev/api/auth/login", {
          method: "POST",
          body: "{}",
        }),
        { BACKEND_URL: "https://edunova-api-y3rx.onrender.com" }
      );
      assert.equal(downRes.status, 502);
      const downBody = await downRes.json();
      assert.match(downBody.error, /temporarily unavailable/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
