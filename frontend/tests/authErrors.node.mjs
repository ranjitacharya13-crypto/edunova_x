// Unit checks for the authentication error mapping (frontend/src/api/authErrors.js).
//
// Run with plain Node (no browser, no Vite):
//     node frontend/tests/authErrors.node.mjs
//
// It pins the requirement that the UI distinguishes a malformed request (400),
// wrong credentials (401), a server failure (5xx), an unavailable database (503)
// and an unreachable backend (no response) instead of showing "Invalid
// credentials" for all of them.
//
// Named `.node.mjs` (not `*.test.*` / `*.spec.*`) so Playwright's testDir does
// not try to execute it as a browser test.
import assert from "node:assert/strict";

import { describeAuthFailure, AUTH_MESSAGES } from "../src/api/authErrors.js";

const withStatus = (status, data = {}) => ({ response: { status, data } });

// 200 is never reached here — it is the success path in api.js.
const cases = [
  { name: "network failure (no response)", error: Object.assign(new Error("Network Error"), { code: "ERR_NETWORK" }), expect: AUTH_MESSAGES.NETWORK, status: null },
  { name: "request timeout", error: Object.assign(new Error("timeout"), { code: "ECONNABORTED" }), expect: AUTH_MESSAGES.STARTING, status: null },
  { name: "400 malformed request", error: withStatus(400, { error: "Email and password are required" }), expect: AUTH_MESSAGES.REQUEST, status: 400 },
  { name: "401 wrong credentials", error: withStatus(401, { error: "Invalid credentials" }), expect: AUTH_MESSAGES.INVALID_CREDENTIALS, status: 401 },
  { name: "403 blocked account", error: withStatus(403, { error: "Account disabled" }), expect: "Account disabled", status: 403 },
  { name: "404 wrong API URL", error: withStatus(404, {}), expect: AUTH_MESSAGES.CONFIG, status: 404 },
  { name: "503 database unavailable", error: withStatus(503, { error: "Database unavailable (disconnected). Please try again in a moment." }), expect: "Database unavailable (disconnected). Please try again in a moment.", status: 503 },
  { name: "500 server error", error: withStatus(500, { error: "Login failed" }), expect: AUTH_MESSAGES.SERVER, status: 500 },
  { name: "502 upstream/proxy error", error: withStatus(502, {}), expect: AUTH_MESSAGES.SERVER, status: 502 },
];

let failed = 0;
for (const testCase of cases) {
  const result = describeAuthFailure(testCase.error);
  try {
    assert.equal(result.message, testCase.expect);
    assert.equal(result.status, testCase.status);
    console.log(`✅ ${testCase.name} → "${result.message}"`);
  } catch (err) {
    failed += 1;
    console.error(`❌ ${testCase.name} → got "${result.message}" (${result.status}), expected "${testCase.expect}" (${testCase.status})`);
  }
}

// The mapping must never invent a credential verdict for a transport failure.
assert.notEqual(describeAuthFailure({ code: "ERR_NETWORK" }).message, AUTH_MESSAGES.INVALID_CREDENTIALS);
assert.notEqual(describeAuthFailure({ response: { status: 500, data: {} } }).message, AUTH_MESSAGES.INVALID_CREDENTIALS);
assert.notEqual(describeAuthFailure({ response: { status: 400, data: {} } }).message, AUTH_MESSAGES.INVALID_CREDENTIALS);

if (failed > 0) {
  console.error(`\n${failed} auth error-mapping check(s) failed`);
  process.exit(1);
}
console.log(`\nAll ${cases.length} auth error-mapping checks passed`);
