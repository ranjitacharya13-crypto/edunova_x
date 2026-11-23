// Unit/integration tests for server/services/demoAccount.js
const { test, beforeEach, describe } = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const mongoose = require("mongoose");

const User = require("../models/User");
const {
  ensureDemoStudent,
  ensureDevDemoUsers,
  DEFAULT_DEMO_EMAIL,
  DEFAULT_DEMO_PASSWORD,
  DEFAULT_DEMO_USERNAME,
} = require("../services/demoAccount");

const silent = { log() {}, warn() {}, error() {} };

let store = [];

function matchesField(actual, expected) {
  if (expected instanceof RegExp) return expected.test(String(actual || ""));
  if (expected && typeof expected === "object" && expected.$regex instanceof RegExp) {
    return expected.$regex.test(String(actual || ""));
  }
  return actual === expected;
}

function installStubs() {
  User.findOne = async (query = {}) => {
    if ("email" in query) {
      return store.find((u) => matchesField(u.email, query.email)) || null;
    }
    if ("username" in query) {
      return store.find((u) => matchesField(u.username, query.username)) || null;
    }
    return null;
  };

  User.prototype.save = async function saveStub() {
    if (!this._id) this._id = new mongoose.Types.ObjectId();
    if (!store.includes(this)) store.push(this);
    return this;
  };
}

beforeEach(() => {
  store = [];
  delete process.env.SEED_DEMO_STUDENT;
  delete process.env.SEED_DEMO_USERS;
  delete process.env.DEMO_STUDENT_PASSWORD;
  delete process.env.NODE_ENV;
  installStubs();
});

describe("ensureDemoStudent", () => {
  test("provisions student@edunova.demo by default with bcrypt hash and student role", async () => {
    const res = await ensureDemoStudent({ log: silent });
    assert.equal(res.status, "created");
    assert.equal(store.length, 1);
    const created = store[0];
    assert.equal(created.email, DEFAULT_DEMO_EMAIL);
    assert.equal(created.role, "student");
    assert.equal(created.isBlocked, false);
    assert.match(created.password, /^\$2[aby]\$/);
    assert.ok(await bcrypt.compare(DEFAULT_DEMO_PASSWORD, created.password));
  });

  test("is idempotent across repeated boots", async () => {
    await ensureDemoStudent({ log: silent });
    const second = await ensureDemoStudent({ log: silent });
    const third = await ensureDemoStudent({ log: silent });
    assert.equal(second.status, "already-ok");
    assert.equal(third.status, "already-ok");
    assert.equal(store.length, 1);
  });

  test("reconciles drifted password hash and accidental isBlocked flag on the demo student", async () => {
    store.push(
      new User({
        name: "Demo Student",
        username: DEFAULT_DEMO_USERNAME,
        email: "Student@EduNova.Demo",
        password: "plaintext-or-drifted",
        role: "student",
        isBlocked: true,
      })
    );

    const res = await ensureDemoStudent({ log: silent });
    assert.equal(res.status, "reconciled");
    assert.equal(store[0].email, DEFAULT_DEMO_EMAIL);
    assert.equal(store[0].isBlocked, false);
    assert.match(store[0].password, /^\$2[aby]\$/);
    assert.ok(await bcrypt.compare(DEFAULT_DEMO_PASSWORD, store[0].password));
  });

  test("never modifies an existing privileged account with role mismatch", async () => {
    store.push(
      new User({
        name: "Protected Admin",
        username: "super_admin",
        email: DEFAULT_DEMO_EMAIL,
        password: "untouched-admin-hash",
        role: "admin",
      })
    );

    const res = await ensureDemoStudent({ log: silent });
    assert.equal(res.status, "skipped-role-mismatch");
    assert.equal(store[0].password, "untouched-admin-hash");
    assert.equal(store[0].role, "admin");
  });

  test("handles username collision without E11000 failure", async () => {
    store.push(
      new User({
        name: "Existing User",
        username: DEFAULT_DEMO_USERNAME,
        email: "other@example.test",
        password: "hash",
        role: "student",
      })
    );

    const res = await ensureDemoStudent({ log: silent });
    assert.equal(res.status, "created");
    assert.equal(store.length, 2);
    const demo = store.find((u) => u.email === DEFAULT_DEMO_EMAIL);
    assert.ok(demo);
    assert.notEqual(demo.username, DEFAULT_DEMO_USERNAME);
  });

  test("respects SEED_DEMO_STUDENT=false", async () => {
    process.env.SEED_DEMO_STUDENT = "false";
    const res = await ensureDemoStudent({ log: silent });
    assert.equal(res.status, "disabled");
    assert.equal(store.length, 0);
  });
});

describe("ensureDevDemoUsers", () => {
  test("never seeds dev teacher/student accounts in production even if SEED_DEMO_USERS=true", async () => {
    process.env.NODE_ENV = "production";
    process.env.SEED_DEMO_USERS = "true";
    const res = await ensureDevDemoUsers({ log: silent });
    assert.equal(res.status, "skipped-production");
    assert.equal(store.length, 0);
  });

  test("seeds dev teacher and student in non-production when SEED_DEMO_USERS=true", async () => {
    process.env.NODE_ENV = "development";
    process.env.SEED_DEMO_USERS = "true";
    const res = await ensureDevDemoUsers({ log: silent });
    assert.equal(res.status, "ok");
    assert.equal(store.length, 2);
    assert.ok(store.some((u) => u.email === "teacher@edunova.com" && u.role === "teacher"));
    assert.ok(store.some((u) => u.email === "student@edunova.com" && u.role === "student"));
  });
});
