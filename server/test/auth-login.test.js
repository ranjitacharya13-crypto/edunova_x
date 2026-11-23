// Integration tests for POST /api/auth/login (server/routes/auth.js) and
// the login rate limiter (server/middleware/loginRateLimit.js).
//
// Run with Node's built-in test runner: `npm test` (in server/).
//
// No MongoDB or network access is required: the mongoose user lookup and
// connection state are stubbed, exactly like test/ai-route.test.js stubs
// the auth middleware. Passwords are hashed with the real bcryptjs so the
// verification path is genuine. Secrets are never asserted or logged here;
// one test captures console output and asserts the plaintext password and
// the issued token never appear in the logs.

const { test, before, after, describe } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const express = require("express");
const bcrypt = require("bcryptjs");
const mongoose = require("mongoose");

process.env.JWT_SECRET = process.env.JWT_SECRET || "auth-login-test-secret";

const User = require("../models/User");
const authRoutes = require("../routes/auth");
const rateLimit = require("../middleware/loginRateLimit");

const PASSWORD = "CorrectHorseBatteryStaple1";
const DEMO_EMAIL = "student@edunova.demo";
const DEMO_PASSWORD = "Student@12345";

let hashedPassword;
let hashedDemoPassword;
let server;
let baseUrl;

// In-memory "database": email/username -> user record.
const users = new Map();

function addUser({ email, username, passwordHash, role = "student", isBlocked = false }) {
  const user = {
    _id: `user-${users.size + 1}`,
    name: "Test User",
    email,
    username,
    password: passwordHash,
    role,
    isBlocked,
  };
  users.set(email, user);
  if (username) users.set(username, user);
  return user;
}

function stubUserLookup() {
  User.findOne = (query) => {
    const key = query?.$or?.[0]?.email ?? query?.email;
    return Promise.resolve(users.get(key) || null);
  };
}

function postLogin(body, headers = {}) {
  return fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function loginJson(body, headers) {
  const res = await postLogin(body, headers);
  return { status: res.status, body: await res.json(), headers: res.headers };
}

before(async () => {
  hashedPassword = await bcrypt.hash(PASSWORD, 4);
  hashedDemoPassword = await bcrypt.hash(DEMO_PASSWORD, 4);
  addUser({ email: "alice@example.test", username: "alice", passwordHash: hashedPassword });
  addUser({ email: DEMO_EMAIL, username: "student_demo_account", passwordHash: hashedDemoPassword });
  stubUserLookup();
  // Pretend MongoDB is connected (the route 503s otherwise).
  mongoose.connection.readyState = 1;

  const app = express();
  app.set("trust proxy", 1);
  app.use(express.json());
  app.use("/api/auth", authRoutes);
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  mongoose.connection.readyState = 0;
});

function resetLimiter() {
  rateLimit._resetStore();
  delete process.env.LOGIN_MAX_FAILURES_PER_ACCOUNT;
  delete process.env.LOGIN_MAX_FAILURES_PER_IP;
  delete process.env.LOGIN_WINDOW_MS;
}

describe("POST /api/auth/login", () => {
  test("valid credentials return 200 with a token and user", async () => {
    resetLimiter();
    const { status, body } = await loginJson({ email: "alice@example.test", password: PASSWORD });
    assert.equal(status, 200);
    assert.ok(typeof body.token === "string" && body.token.length > 0);
    assert.equal(body.user.email, "alice@example.test");
    assert.equal(body.user.role, "student");
  });

  test("login by username also works", async () => {
    resetLimiter();
    const { status, body } = await loginJson({ email: "alice", password: PASSWORD });
    assert.equal(status, 200);
    assert.equal(body.user.email, "alice@example.test");
  });

  test("demo student credentials work", async () => {
    resetLimiter();
    const { status, body } = await loginJson({ email: DEMO_EMAIL, password: DEMO_PASSWORD });
    assert.equal(status, 200);
    assert.equal(body.user.role, "student");
  });

  test("wrong password returns generic 400 Invalid credentials", async () => {
    resetLimiter();
    const { status, body } = await loginJson({ email: "alice@example.test", password: "wrong-password" });
    assert.equal(status, 400);
    assert.equal(body.error, "Invalid credentials");
  });

  test("unknown email returns the SAME generic 400 (no enumeration)", async () => {
    resetLimiter();
    const { status, body } = await loginJson({ email: "nobody@example.test", password: "whatever" });
    assert.equal(status, 400);
    assert.equal(body.error, "Invalid credentials");
  });

  test("missing fields return 400", async () => {
    resetLimiter();
    const { status, body } = await loginJson({ email: "", password: "" });
    assert.equal(status, 400);
    assert.equal(body.error, "Missing email or password");
  });

  test("blocked user returns generic 400", async () => {
    resetLimiter();
    addUser({ email: "blocked@example.test", username: "blocked", passwordHash: hashedPassword, isBlocked: true });
    const { status, body } = await loginJson({ email: "blocked@example.test", password: PASSWORD });
    assert.equal(status, 400);
    assert.equal(body.error, "Invalid credentials");
  });

  test("database unavailable returns 503, not 500", async () => {
    resetLimiter();
    mongoose.connection.readyState = 0;
    try {
      const { status, body } = await loginJson({ email: "alice@example.test", password: PASSWORD });
      assert.equal(status, 503);
      assert.match(body.error, /temporarily unavailable/);
    } finally {
      mongoose.connection.readyState = 1;
    }
  });

  test("logs never contain the plaintext password or the issued token", async () => {
    resetLimiter();
    const lines = [];
    const originalLog = console.log;
    console.log = (...args) => lines.push(args.join(" "));
    try {
      const { status, body } = await loginJson({ email: "alice@example.test", password: PASSWORD });
      assert.equal(status, 200);
      const joined = lines.join("\n");
      assert.ok(!joined.includes(PASSWORD), "password leaked into logs");
      assert.ok(!joined.includes(body.token), "token leaked into logs");
      assert.ok(!joined.includes(hashedPassword), "password hash leaked into logs");
    } finally {
      console.log = originalLog;
    }
  });
});

describe("login rate limiting", () => {
  test("account locks after N failures, even with the correct password", async () => {
    resetLimiter();
    process.env.LOGIN_MAX_FAILURES_PER_ACCOUNT = "3";
    process.env.LOGIN_MAX_FAILURES_PER_IP = "100";
    for (let i = 0; i < 3; i += 1) {
      const { status } = await loginJson({ email: "alice@example.test", password: "wrong" });
      assert.equal(status, 400);
    }
    const locked = await loginJson({ email: "alice@example.test", password: PASSWORD });
    assert.equal(locked.status, 429);
    assert.match(locked.body.error, /Too many sign-in attempts/);
    assert.ok(Number(locked.body.retryAfterSeconds) > 0);
    assert.ok(locked.headers.get("Retry-After"));
    resetLimiter();
  });

  test("a successful login resets the account failure counter", async () => {
    resetLimiter();
    process.env.LOGIN_MAX_FAILURES_PER_ACCOUNT = "3";
    process.env.LOGIN_MAX_FAILURES_PER_IP = "100";
    // 2 failures, then a success, then 2 more failures: never locked.
    await loginJson({ email: "alice@example.test", password: "wrong" });
    await loginJson({ email: "alice@example.test", password: "wrong" });
    const ok = await loginJson({ email: "alice@example.test", password: PASSWORD });
    assert.equal(ok.status, 200);
    await loginJson({ email: "alice@example.test", password: "wrong" });
    await loginJson({ email: "alice@example.test", password: "wrong" });
    const stillOk = await loginJson({ email: "alice@example.test", password: PASSWORD });
    assert.equal(stillOk.status, 200);
    resetLimiter();
  });

  test("one locked account does not block a different user on the same IP", async () => {
    resetLimiter();
    process.env.LOGIN_MAX_FAILURES_PER_ACCOUNT = "2";
    process.env.LOGIN_MAX_FAILURES_PER_IP = "100";
    await loginJson({ email: "alice@example.test", password: "wrong" });
    await loginJson({ email: "alice@example.test", password: "wrong" });
    const aliceLocked = await loginJson({ email: "alice@example.test", password: PASSWORD });
    assert.equal(aliceLocked.status, 429);
    // Same source IP, different account: must still work.
    const demo = await loginJson({ email: DEMO_EMAIL, password: DEMO_PASSWORD });
    assert.equal(demo.status, 200);
    resetLimiter();
  });

  test("IP bucket stops spraying many accounts from one source", async () => {
    resetLimiter();
    process.env.LOGIN_MAX_FAILURES_PER_ACCOUNT = "100";
    process.env.LOGIN_MAX_FAILURES_PER_IP = "3";
    for (let i = 0; i < 3; i += 1) {
      const { status } = await loginJson({ email: `spray${i}@example.test`, password: "wrong" });
      assert.equal(status, 400);
    }
    const blocked = await loginJson({ email: "alice@example.test", password: PASSWORD });
    assert.equal(blocked.status, 429);
    resetLimiter();
  });

  test("lockout expires after the window and login works again", async () => {
    resetLimiter();
    process.env.LOGIN_MAX_FAILURES_PER_ACCOUNT = "2";
    process.env.LOGIN_MAX_FAILURES_PER_IP = "100";
    process.env.LOGIN_WINDOW_MS = "150";
    await loginJson({ email: "alice@example.test", password: "wrong" });
    await loginJson({ email: "alice@example.test", password: "wrong" });
    const locked = await loginJson({ email: "alice@example.test", password: PASSWORD });
    assert.equal(locked.status, 429);
    await new Promise((resolve) => setTimeout(resolve, 220));
    const recovered = await loginJson({ email: "alice@example.test", password: PASSWORD });
    assert.equal(recovered.status, 200);
    resetLimiter();
  });

  test("unknown emails count toward the account bucket (no oracle)", async () => {
    resetLimiter();
    process.env.LOGIN_MAX_FAILURES_PER_ACCOUNT = "2";
    process.env.LOGIN_MAX_FAILURES_PER_IP = "100";
    await loginJson({ email: "ghost@example.test", password: "wrong" });
    await loginJson({ email: "ghost@example.test", password: "wrong" });
    const locked = await loginJson({ email: "ghost@example.test", password: "wrong" });
    assert.equal(locked.status, 429);
    resetLimiter();
  });
});

describe("getClientIp trust model", () => {
  const mockReq = (headers, ip = "10.0.0.1") => ({ headers, ip });

  test("without PROXY_SECRET, forwarded headers are ignored", () => {
    delete process.env.PROXY_SECRET;
    const req = mockReq({ "cf-connecting-ip": "203.0.113.7" }, "10.0.0.1");
    assert.equal(rateLimit.getClientIp(req), "10.0.0.1");
  });

  test("with matching PROXY_SECRET, worker-forwarded IP is trusted", () => {
    process.env.PROXY_SECRET = "test-secret";
    const req = mockReq({ "cf-connecting-ip": "203.0.113.7", "x-proxy-secret": "test-secret" }, "10.0.0.1");
    assert.equal(rateLimit.getClientIp(req), "203.0.113.7");
    delete process.env.PROXY_SECRET;
  });

  test("with wrong PROXY_SECRET, forwarded IP is NOT trusted", () => {
    process.env.PROXY_SECRET = "test-secret";
    const req = mockReq({ "cf-connecting-ip": "203.0.113.7", "x-proxy-secret": "forged" }, "10.0.0.1");
    assert.equal(rateLimit.getClientIp(req), "10.0.0.1");
    delete process.env.PROXY_SECRET;
  });
});
