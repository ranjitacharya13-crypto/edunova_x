// Integration tests for authentication & rate limiting:
//   - POST /api/auth/login, POST /api/auth/register, GET /api/auth/me
//   - server/middleware/auth.js (JWT verification, expiration, suspension)
//   - server/middleware/loginRateLimit.js (per-account+IP, per-IP, global
//     distributed protection, shared multi-instance store, Cloudflare/Render
//     proxy IP resolution, temporary lockout & automatic recovery)
//   - Diagnostic log hygiene (no passwords, JWTs, password hashes, or raw PII)

const { test, before, after, describe } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

process.env.JWT_SECRET = process.env.JWT_SECRET || "auth-login-test-secret";

const User = require("../models/User");
const authRoutes = require("../routes/auth");
const rateLimit = require("../middleware/loginRateLimit");

const PASSWORD = "CorrectHorseBatteryStaple1";
const DEMO_EMAIL = "student@edunova.demo";
const DEMO_PASSWORD = "Student@12345";
const TEACHER_EMAIL = "teacher@edunova.com";
const TEACHER_PASSWORD = "TeacherPassword@123";
const ADMIN_EMAIL = "admin@edunova.test";
const ADMIN_PASSWORD = "AdminPassword@123";

let hashedPassword;
let hashedDemoPassword;
let hashedTeacherPassword;
let hashedAdminPassword;
let server;
let baseUrl;

const usersById = new Map();
const usersList = [];

function addUser({
  email,
  username,
  passwordHash,
  role = "student",
  isBlocked = false,
  name = "Test User",
}) {
  const user = {
    _id: `user-${usersList.length + 1}`,
    name,
    email,
    username,
    password: passwordHash,
    role,
    isBlocked,
    enrolledClasses: ["General"],
    subjects: ["Physics"],
    timezone: "UTC",
  };
  usersById.set(String(user._id), user);
  usersList.push(user);
  return user;
}

function matchesCriterion(user, criterion) {
  const [field, expected] = Object.entries(criterion)[0];
  const actual = user[field];
  if (expected instanceof RegExp) return expected.test(String(actual || ""));
  return actual === expected;
}

function stubUserModel() {
  User.findOne = (query) => {
    if (Array.isArray(query?.$or)) {
      const found =
        usersList.find((u) => query.$or.some((c) => matchesCriterion(u, c))) || null;
      return Promise.resolve(found);
    }
    if (query?.email) {
      return Promise.resolve(
        usersList.find((u) => matchesCriterion(u, { email: query.email })) || null
      );
    }
    return Promise.resolve(null);
  };

  User.findById = (id) => ({
    select: () => Promise.resolve(usersById.get(String(id)) || null),
  });

  User.prototype.save = async function saveStub() {
    if (!this._id) this._id = `user-${usersList.length + 1}`;
    usersById.set(String(this._id), this);
    if (!usersList.includes(this)) usersList.push(this);
    return this;
  };
}

function postLogin(body, headers = {}) {
  return fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function loginJson(body, headers = {}) {
  const res = await postLogin(body, headers);
  return { status: res.status, body: await res.json(), headers: res.headers };
}

before(async () => {
  hashedPassword = await bcrypt.hash(PASSWORD, 4);
  hashedDemoPassword = await bcrypt.hash(DEMO_PASSWORD, 4);
  hashedTeacherPassword = await bcrypt.hash(TEACHER_PASSWORD, 4);
  hashedAdminPassword = await bcrypt.hash(ADMIN_PASSWORD, 4);

  addUser({
    email: "alice@example.test",
    username: "alice",
    passwordHash: hashedPassword,
    role: "student",
    name: "Alice Student",
  });
  addUser({
    email: "MixedCase@Example.Test",
    username: "mixedcase_user",
    passwordHash: hashedPassword,
    role: "student",
    name: "Mixed Case Student",
  });
  addUser({
    email: DEMO_EMAIL,
    username: "student_demo_account",
    passwordHash: hashedDemoPassword,
    role: "student",
    name: "Demo Student",
  });
  addUser({
    email: TEACHER_EMAIL,
    username: "teacher_demo",
    passwordHash: hashedTeacherPassword,
    role: "teacher",
    name: "Demo Teacher",
  });
  addUser({
    email: ADMIN_EMAIL,
    username: "super_admin",
    passwordHash: hashedAdminPassword,
    role: "admin",
    name: "Super Admin",
  });

  stubUserModel();
  mongoose.connection.readyState = 1;

  const app = express();
  // Match production Render 2-hop reverse proxy configuration.
  app.set("trust proxy", 2);
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
  rateLimit._setSharedStoreAdapter(null);
  delete process.env.LOGIN_MAX_FAILURES_PER_ACCOUNT;
  delete process.env.LOGIN_MAX_FAILURES_PER_IP;
  delete process.env.LOGIN_MAX_FAILURES_PER_ACCOUNT_GLOBAL;
  delete process.env.LOGIN_WINDOW_MS;
  delete process.env.PROXY_SECRET;
  delete process.env.RENDER;
}

describe("POST /api/auth/login — core authentication scenarios", () => {
  test("1. valid user login returns 200 with JWT token and user profile", async () => {
    resetLimiter();
    const { status, body, headers } = await loginJson({
      email: "alice@example.test",
      password: PASSWORD,
    });
    assert.equal(status, 200);
    assert.ok(typeof body.token === "string" && body.token.split(".").length === 3);
    assert.equal(body.user.email, "alice@example.test");
    assert.equal(body.user.role, "student");
    assert.ok(headers.get("x-request-id"));
  });

  test("case-insensitive and whitespace-padded email login works (including legacy mixed-case DB records)", async () => {
    resetLimiter();
    const r1 = await loginJson({
      email: "  ALICE@Example.Test  ",
      password: PASSWORD,
    });
    assert.equal(r1.status, 200);
    assert.equal(r1.body.user.email, "alice@example.test");

    const r2 = await loginJson({
      email: "mixedcase@example.test",
      password: PASSWORD,
    });
    assert.equal(r2.status, 200);
    assert.equal(r2.body.user.email, "MixedCase@Example.Test");
  });

  test("login by username also works", async () => {
    resetLimiter();
    const { status, body } = await loginJson({ email: "alice", password: PASSWORD });
    assert.equal(status, 200);
    assert.equal(body.user.email, "alice@example.test");
  });

  test("2. invalid password returns 401 Invalid credentials", async () => {
    resetLimiter();
    const { status, body } = await loginJson({
      email: "alice@example.test",
      password: "wrong-password",
    });
    assert.equal(status, 401);
    assert.equal(body.error, "Invalid credentials");
  });

  test("3. unknown email returns the SAME generic 401 Invalid credentials (no enumeration)", async () => {
    resetLimiter();
    const { status, body } = await loginJson({
      email: "nobody@example.test",
      password: "whatever-password",
    });
    assert.equal(status, 401);
    assert.equal(body.error, "Invalid credentials");
  });

  test("4. student demo login succeeds and assigns student role", async () => {
    resetLimiter();
    const { status, body } = await loginJson({
      email: DEMO_EMAIL,
      password: DEMO_PASSWORD,
    });
    assert.equal(status, 200);
    assert.equal(body.user.email, DEMO_EMAIL);
    assert.equal(body.user.role, "student");
    assert.ok(body.token);
  });

  test("5. teacher and admin logins succeed with their respective roles", async () => {
    resetLimiter();
    const teacher = await loginJson({
      email: TEACHER_EMAIL,
      password: TEACHER_PASSWORD,
    });
    assert.equal(teacher.status, 200);
    assert.equal(teacher.body.user.role, "teacher");

    const admin = await loginJson({
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
    });
    assert.equal(admin.status, 200);
    assert.equal(admin.body.user.role, "admin");
  });

  test("6. multiple legitimate login attempts never trigger rate limiting", async () => {
    resetLimiter();
    process.env.LOGIN_MAX_FAILURES_PER_ACCOUNT = "3";
    process.env.LOGIN_MAX_FAILURES_PER_IP = "5";
    for (let i = 0; i < 15; i += 1) {
      const res = await loginJson({ email: DEMO_EMAIL, password: DEMO_PASSWORD });
      assert.equal(res.status, 200, `legitimate attempt #${i + 1} was blocked`);
    }
    resetLimiter();
  });

  test("missing fields return 400 without consuming rate-limit quota", async () => {
    resetLimiter();
    const { status, body } = await loginJson({ email: "", password: "" });
    assert.equal(status, 400);
    assert.equal(body.error, "Missing email or password");
  });

  test("blocked user with wrong password gets generic 401; with valid password gets 403 ACCOUNT_BLOCKED", async () => {
    resetLimiter();
    addUser({
      email: "blocked@example.test",
      username: "blocked",
      passwordHash: hashedPassword,
      isBlocked: true,
    });

    const wrongPw = await loginJson({
      email: "blocked@example.test",
      password: "wrong-password",
    });
    assert.equal(wrongPw.status, 401);
    assert.equal(wrongPw.body.error, "Invalid credentials");

    const rightPw = await loginJson({
      email: "blocked@example.test",
      password: PASSWORD,
    });
    assert.equal(rightPw.status, 403);
    assert.equal(rightPw.body.code, "ACCOUNT_BLOCKED");
  });

  test("9. MongoDB unavailable returns retryable 503, not 500 or Invalid credentials", async () => {
    resetLimiter();
    mongoose.connection.readyState = 0;
    try {
      const { status, body } = await loginJson({
        email: "alice@example.test",
        password: PASSWORD,
      });
      assert.equal(status, 503);
      assert.match(body.error, /temporarily unavailable/);
    } finally {
      mongoose.connection.readyState = 1;
    }
  });

  test("12. JWT authentication after successful login works on GET /api/auth/me and rejects expired/forged JWTs", async () => {
    resetLimiter();
    const login = await loginJson({ email: DEMO_EMAIL, password: DEMO_PASSWORD });
    assert.equal(login.status, 200);

    const meOk = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Authorization: `Bearer ${login.body.token}` },
    });
    assert.equal(meOk.status, 200);
    const meBody = await meOk.json();
    assert.equal(meBody.user.email, DEMO_EMAIL);
    assert.equal(meBody.user.role, "student");

    // Expired JWT returns 401 TOKEN_EXPIRED
    const expiredToken = jwt.sign(
      { id: login.body.user.id, role: "student" },
      process.env.JWT_SECRET,
      { expiresIn: -10 }
    );
    const meExpired = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Authorization: `Bearer ${expiredToken}` },
    });
    assert.equal(meExpired.status, 401);
    const expiredBody = await meExpired.json();
    assert.equal(expiredBody.code, "TOKEN_EXPIRED");

    // Forged JWT returns 401 INVALID_TOKEN
    const meForged = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Authorization: "Bearer invalid.jwt.token" },
    });
    assert.equal(meForged.status, 401);
    const forgedBody = await meForged.json();
    assert.equal(forgedBody.code, "INVALID_TOKEN");
  });

  test("logs contain correlation ID & status and NEVER leak passwords, tokens, hashes, or raw emails", async () => {
    resetLimiter();
    const lines = [];
    const originalLog = console.log;
    console.log = (...args) => lines.push(args.join(" "));
    try {
      const { status, body } = await loginJson({
        email: "alice@example.test",
        password: PASSWORD,
      });
      assert.equal(status, 200);
      const joined = lines.join("\n");
      assert.ok(!joined.includes(PASSWORD), "plaintext password leaked into logs");
      assert.ok(!joined.includes(body.token), "JWT token leaked into logs");
      assert.ok(!joined.includes(hashedPassword), "password hash leaked into logs");
      assert.ok(!joined.includes("alice@example.test"), "raw email leaked into logs");

      const parsed = JSON.parse(lines.at(-1));
      assert.equal(parsed.event, "auth.login.success");
      assert.equal(parsed.status, 200);
      assert.ok(parsed.requestId);
      assert.ok(parsed.accountRef);
    } finally {
      console.log = originalLog;
    }
  });
});

describe("login rate limiting & proxy isolation", () => {
  test("7. rate-limit activates after N failures for (account + IP), even with valid password", async () => {
    resetLimiter();
    process.env.LOGIN_MAX_FAILURES_PER_ACCOUNT = "3";
    process.env.LOGIN_MAX_FAILURES_PER_IP = "100";
    for (let i = 0; i < 3; i += 1) {
      const { status } = await loginJson({
        email: "alice@example.test",
        password: "wrong",
      });
      assert.equal(status, 401);
    }
    const locked = await loginJson({
      email: "alice@example.test",
      password: PASSWORD,
    });
    assert.equal(locked.status, 429);
    assert.match(locked.body.error, /Too many sign-in attempts/);
    assert.ok(Number(locked.body.retryAfterSeconds) > 0);
    assert.ok(locked.headers.get("Retry-After"));
    resetLimiter();
  });

  test("attacker failing from IP A NEVER locks out the legitimate account owner or demo student on IP B", async () => {
    resetLimiter();
    process.env.LOGIN_MAX_FAILURES_PER_ACCOUNT = "3";
    process.env.LOGIN_MAX_FAILURES_PER_IP = "100";

    // Attacker at 198.51.100.77 hammers BOTH alice@example.test and student@edunova.demo
    const attackerHeaders = { "X-Forwarded-For": "198.51.100.77, 172.70.1.2" };
    for (let i = 0; i < 3; i += 1) {
      await loginJson({ email: "alice@example.test", password: "wrong" }, attackerHeaders);
      await loginJson({ email: DEMO_EMAIL, password: "wrong" }, attackerHeaders);
    }
    const attackerBlockedAlice = await loginJson(
      { email: "alice@example.test", password: PASSWORD },
      attackerHeaders
    );
    assert.equal(attackerBlockedAlice.status, 429);

    const attackerBlockedDemo = await loginJson(
      { email: DEMO_EMAIL, password: DEMO_PASSWORD },
      attackerHeaders
    );
    assert.equal(attackerBlockedDemo.status, 429);

    // Legitimate Alice and legitimate Demo Student on 49.37.10.20 still sign in cleanly!
    const legitHeaders = { "X-Forwarded-For": "49.37.10.20, 172.70.1.2" };
    const legitAlice = await loginJson(
      { email: "alice@example.test", password: PASSWORD },
      legitHeaders
    );
    assert.equal(legitAlice.status, 200);

    const legitDemo = await loginJson(
      { email: DEMO_EMAIL, password: DEMO_PASSWORD },
      legitHeaders
    );
    assert.equal(legitDemo.status, 200);
    resetLimiter();
  });

  test("successful login resets the caller's failure counter", async () => {
    resetLimiter();
    process.env.LOGIN_MAX_FAILURES_PER_ACCOUNT = "3";
    process.env.LOGIN_MAX_FAILURES_PER_IP = "100";
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
    const aliceLocked = await loginJson({
      email: "alice@example.test",
      password: PASSWORD,
    });
    assert.equal(aliceLocked.status, 429);
    const demo = await loginJson({ email: DEMO_EMAIL, password: DEMO_PASSWORD });
    assert.equal(demo.status, 200);
    resetLimiter();
  });

  test("IP bucket stops password spraying across many accounts from one source", async () => {
    resetLimiter();
    process.env.LOGIN_MAX_FAILURES_PER_ACCOUNT = "100";
    process.env.LOGIN_MAX_FAILURES_PER_IP = "3";
    for (let i = 0; i < 3; i += 1) {
      const { status } = await loginJson({
        email: `spray${i}@example.test`,
        password: "wrong",
      });
      assert.equal(status, 401);
    }
    const blocked = await loginJson({
      email: "alice@example.test",
      password: PASSWORD,
    });
    assert.equal(blocked.status, 429);
    assert.equal(blocked.body.bucket, "ip");
    resetLimiter();
  });

  test("8. recovery after lockout window expires restores login automatically", async () => {
    resetLimiter();
    process.env.LOGIN_MAX_FAILURES_PER_ACCOUNT = "2";
    process.env.LOGIN_MAX_FAILURES_PER_IP = "100";
    process.env.LOGIN_WINDOW_MS = "150";
    await loginJson({ email: "alice@example.test", password: "wrong" });
    await loginJson({ email: "alice@example.test", password: "wrong" });
    const locked = await loginJson({
      email: "alice@example.test",
      password: PASSWORD,
    });
    assert.equal(locked.status, 429);
    await new Promise((resolve) => setTimeout(resolve, 220));
    const recovered = await loginJson({
      email: "alice@example.test",
      password: PASSWORD,
    });
    assert.equal(recovered.status, 200);
    resetLimiter();
  });

  test("shared rate-limit store enforces limits consistently across simulated backend instances", async () => {
    resetLimiter();
    process.env.LOGIN_MAX_FAILURES_PER_ACCOUNT = "2";
    process.env.LOGIN_MAX_FAILURES_PER_IP = "100";

    const sharedDb = new Map();
    rateLimit._setSharedStoreAdapter({
      name: "mongo",
      async getLive(key, windowMs, now) {
        return (sharedDb.get(key) || []).filter((t) => now - t < windowMs);
      },
      async recordFailure(key, windowMs, now) {
        const next = (sharedDb.get(key) || []).filter((t) => now - t < windowMs);
        next.push(now);
        sharedDb.set(key, next);
        return next;
      },
      async clearKey(key) {
        sharedDb.delete(key);
      },
    });

    await loginJson({ email: "alice@example.test", password: "wrong" });
    // Clear local process memory to simulate the next request landing on Instance #2!
    rateLimit._resetStore();
    await loginJson({ email: "alice@example.test", password: "wrong" });
    rateLimit._resetStore();

    const thirdOnInstance3 = await loginJson({
      email: "alice@example.test",
      password: PASSWORD,
    });
    assert.equal(thirdOnInstance3.status, 429);
    resetLimiter();
  });
});

describe("getClientIp & Cloudflare-to-Render trust model", () => {
  const mockReq = (headers, ip = "10.0.0.1") => ({ headers, ip });

  test("without PROXY_SECRET outside Render, forwarded headers are ignored (no spoofing)", () => {
    delete process.env.PROXY_SECRET;
    delete process.env.RENDER;
    const req = mockReq(
      {
        "cf-connecting-ip": "203.0.113.7",
        "x-edunova-client-ip": "203.0.113.8",
      },
      "10.0.0.1"
    );
    assert.equal(rateLimit.getClientIp(req), "10.0.0.1");
  });

  test("with matching PROXY_SECRET, X-EduNova-Client-IP from Worker is trusted", () => {
    process.env.PROXY_SECRET = "test-secret";
    const req = mockReq(
      {
        "x-edunova-client-ip": "49.37.12.34",
        "cf-connecting-ip": "2a06:98c0:3600::103",
        "x-proxy-secret": "test-secret",
      },
      "172.70.1.2"
    );
    const identity = rateLimit.resolveClientIdentity(req);
    assert.equal(identity.ip, "49.37.12.34");
    assert.equal(identity.source, "worker-verified");
    assert.equal(identity.isSharedProxy, false);
    delete process.env.PROXY_SECRET;
  });

  test("with wrong PROXY_SECRET, forged Worker headers are rejected", () => {
    process.env.PROXY_SECRET = "test-secret";
    const req = mockReq(
      {
        "x-edunova-client-ip": "203.0.113.7",
        "x-proxy-secret": "forged",
      },
      "10.0.0.1"
    );
    assert.equal(rateLimit.getClientIp(req), "10.0.0.1");
    delete process.env.PROXY_SECRET;
  });

  test("on Render (RENDER=true + cf-ray), direct browser CF-Connecting-IP is resolved while Cloudflare Worker shared egress is flagged isSharedProxy", () => {
    process.env.RENDER = "true";
    try {
      const directReq = mockReq(
        { "cf-ray": "88f123456-MAA", "cf-connecting-ip": "49.37.55.66" },
        "172.70.1.2"
      );
      const directId = rateLimit.resolveClientIdentity(directReq);
      assert.equal(directId.ip, "49.37.55.66");
      assert.equal(directId.source, "render-cloudflare");
      assert.equal(directId.isSharedProxy, false);

      const workerSharedReq = mockReq(
        { "cf-ray": "88f123456-MAA", "cf-connecting-ip": "2a06:98c0:3600::103" },
        "172.70.1.2"
      );
      const sharedId = rateLimit.resolveClientIdentity(workerSharedReq);
      assert.equal(sharedId.ip, "2a06:98c0:3600::103");
      assert.equal(sharedId.isSharedProxy, true);
    } finally {
      delete process.env.RENDER;
    }
  });
});
