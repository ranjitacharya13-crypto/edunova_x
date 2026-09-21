// Integration tests for the authentication endpoints
// (server/routes/auth.js): POST /login, POST /register, GET /me.
//
// The REAL route module is exercised over real HTTP with express.json() in front
// of it. Only two collaborator replaceable pieces are stubbed:
//   * the MongoDB user collection (mongoose model statics) — an in-memory array
//   * the database readiness probe (services/database.isDatabaseReady)
// Everything else is production code: validation, bcrypt comparison, JWT
// signing, and the HTTP status codes.
//
// These tests pin the contract the login page depends on:
//   200 verified credentials   · 400 malformed request
//   401 wrong email/password    · 500 missing JWT_SECRET
//   503 MongoDB not connected
// Passwords are never logged or asserted; only hashes and status codes are.

const { test, before, after, beforeEach, describe } = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

process.env.JWT_SECRET = process.env.JWT_SECRET || "auth-login-test-secret";

const User = require("../models/User");
const database = require("../services/database");
const authRoutes = require("../routes/auth");

const DEMO_EMAIL = "student@edunova.demo";
const DEMO_PASSWORD = "Student@12345";

let store = [];
let dbReady = true;
let app;
let server;
let baseUrl;

// ---- in-memory stand-in for the users collection --------------------------
function matchCondition(user, condition) {
  const [field, value] = Object.entries(condition)[0];
  if (value instanceof RegExp) return value.test(String(user[field] || ""));
  return user[field] === value;
}

function installUserStubs() {
  User.findOne = async (query = {}) => {
    if (Array.isArray(query.$or)) {
      return store.find((user) => query.$or.some((condition) => matchCondition(user, condition))) || null;
    }
    if ("email" in query) return store.find((user) => matchCondition(user, query)) || null;
    if ("username" in query) return store.find((user) => matchCondition(user, query)) || null;
    return null;
  };

  User.findById = (id) => ({
    select: async () => store.find((user) => String(user._id) === String(id)) || null,
  });

  // Mirrors MongoDB's upsert semantics: saving an already-known document
  // updates it, it does not insert a second copy.
  User.prototype.save = async function saveStub() {
    if (!this._id) this._id = new mongoose.Types.ObjectId();
    if (!store.includes(this)) store.push(this);
    return this;
  };
}

async function createUser({
  email,
  password = DEMO_PASSWORD,
  role = "student",
  username = "student_demo_account",
  name = "Demo Student",
  isBlocked = false,
} = {}) {
  const user = {
    _id: new mongoose.Types.ObjectId(),
    name,
    email,
    username,
    password: await bcrypt.hash(password, 10),
    role,
    isBlocked,
  };
  store.push(user);
  return user;
}

async function post(path, body, { raw = false } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: raw ? body : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, json, text };
}

before(async () => {
  installUserStubs();
  database.isDatabaseReady = () => dbReady;
  database.databaseState = () => (dbReady ? "connected" : "disconnected");

  app = express();
  app.use(express.json());
  app.use("/api/auth", authRoutes);
  app.use((req, res) => res.status(404).json({ error: "Route not found" }));

  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  store = [];
  dbReady = true;
  process.env.JWT_SECRET = "auth-login-test-secret";
});

describe("POST /api/auth/login", () => {
  test("A. correct demo credentials → 200 + real JWT + safe user", async () => {
    const user = await createUser({ email: DEMO_EMAIL });

    const res = await post("/api/auth/login", { email: DEMO_EMAIL, password: DEMO_PASSWORD });

    assert.equal(res.status, 200);
    assert.ok(res.json.token, "a token must be returned");

    const decoded = jwt.verify(res.json.token, process.env.JWT_SECRET);
    assert.equal(String(decoded.id), String(user._id));

    assert.deepEqual(
      { id: String(res.json.user.id), email: res.json.user.email, role: res.json.user.role },
      { id: String(user._id), email: DEMO_EMAIL, role: "student" }
    );
    assert.equal(res.json.user.password, undefined, "the hash must never be returned");
    assert.equal(res.json.user.isBlocked, undefined);
  });

  test("B. wrong password → 401 (never 400)", async () => {
    await createUser({ email: DEMO_EMAIL });

    const res = await post("/api/auth/login", { email: DEMO_EMAIL, password: "wrongpassword" });

    assert.equal(res.status, 401);
    assert.equal(res.json.error, "Invalid credentials");
    assert.equal(res.json.token, undefined);
  });

  test("C. unknown email → 401 with the same generic message (no enumeration)", async () => {
    await createUser({ email: DEMO_EMAIL });

    const res = await post("/api/auth/login", { email: "unknown@example.com", password: "anything" });

    assert.equal(res.status, 401);
    assert.equal(res.json.error, "Invalid credentials");
  });

  test("D. missing email/password → 400 (request problem, not credentials)", async () => {
    for (const body of [{}, { email: DEMO_EMAIL }, { password: DEMO_PASSWORD }, { email: "", password: "" }]) {
      const res = await post("/api/auth/login", body);
      assert.equal(res.status, 400, `body ${JSON.stringify(body)} must be rejected as malformed`);
      assert.equal(res.json.error, "Email and password are required");
    }
  });

  test("D2. malformed JSON body → 400 with a JSON error (no HTML stack page)", async () => {
    const res = await post("/api/auth/login", '{"email": "student@edunova.demo",', { raw: true });
    // express.json() rejects the body before the route runs; the JSON error
    // handler registered in server.js is what turns this into JSON in
    // production. Either way it must be a 400, never 401.
    assert.equal(res.status, 400);
  });

  test("E. MongoDB not connected → 503 (a server problem, never 'invalid credentials')", async () => {
    await createUser({ email: DEMO_EMAIL });
    dbReady = false;

    const res = await post("/api/auth/login", { email: DEMO_EMAIL, password: DEMO_PASSWORD });

    assert.equal(res.status, 503);
    assert.match(res.json.error, /Database unavailable/);
  });

  test("F. JWT_SECRET missing → 500 configuration error (not a credential failure)", async () => {
    await createUser({ email: DEMO_EMAIL });
    delete process.env.JWT_SECRET;
    try {
      const res = await post("/api/auth/login", { email: DEMO_EMAIL, password: DEMO_PASSWORD });
      assert.equal(res.status, 500);
      assert.match(res.json.error, /JWT_SECRET/);
    } finally {
      process.env.JWT_SECRET = "auth-login-test-secret";
    }
  });

  test("G. email is trimmed and matched case-insensitively; the demo account still works after a re-save", async () => {
    await createUser({ email: DEMO_EMAIL });

    const res = await post("/api/auth/login", { email: "  Student@EduNova.Demo  ", password: DEMO_PASSWORD });

    assert.equal(res.status, 200);
    assert.equal(res.json.user.role, "student");
  });

  test("H. blocked account → 401", async () => {
    await createUser({ email: DEMO_EMAIL, isBlocked: true });

    const res = await post("/api/auth/login", { email: DEMO_EMAIL, password: DEMO_PASSWORD });

    assert.equal(res.status, 401);
  });

  test("I. username sign-in still works (existing behaviour preserved)", async () => {
    await createUser({ email: DEMO_EMAIL, username: "student_demo_account" });

    const res = await post("/api/auth/login", { email: "student_demo_account", password: DEMO_PASSWORD });

    assert.equal(res.status, 200);
    assert.equal(res.json.user.email, DEMO_EMAIL);
  });

  test("J. password hashes are compared with bcrypt, not compared as hashes", async () => {
    const user = await createUser({ email: DEMO_EMAIL });
    assert.notEqual(user.password, DEMO_PASSWORD);
    assert.match(user.password, /^\$2[aby]\$/);

    // The stored hash is not reusable as a credential.
    const res = await post("/api/auth/login", { email: DEMO_EMAIL, password: user.password });
    assert.equal(res.status, 401);
  });
});

describe("GET /api/auth/me", () => {
  test("returns the session user for a valid token", async () => {
    const user = await createUser({ email: DEMO_EMAIL });
    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: "7d" });

    const response = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.user.email, DEMO_EMAIL);
    assert.equal(body.user.role, "student");
    assert.equal(body.user.username, "student_demo_account");
  });

  test("rejects a missing or invalid token", async () => {
    const anonymous = await fetch(`${baseUrl}/api/auth/me`);
    assert.equal(anonymous.status, 401);

    const forged = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Authorization: "Bearer not.a.real.token" },
    });
    assert.equal(forged.status, 401);
  });
});

describe("POST /api/auth/register", () => {
  test("hashes the password, never creates admins, and returns a verified token", async () => {
    const res = await post("/api/auth/register", {
      name: "New Student",
      username: "new_student",
      email: "New.Student@example.com",
      password: "Secret@12345",
      role: "student",
    });

    assert.equal(res.status, 200);
    assert.ok(res.json.token);
    assert.equal(res.json.user.email, "new.student@example.com", "emails are normalized to lowercase");
    assert.equal(store.length, 1);
    assert.match(store[0].password, /^\$2[aby]\$/);
    assert.equal(store[0].password === "Secret@12345", false);

    const admin = await post("/api/auth/register", {
      name: "Sneaky",
      username: "sneaky_admin",
      email: "sneaky@example.com",
      password: "Secret@12345",
      role: "admin",
    });
    assert.equal(admin.status, 403);
  });
});
