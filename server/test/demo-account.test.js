// Tests for the idempotent demo-student provisioning
// (server/services/demoAccount.js) that the login page's
// "Login as Demo Student" button depends on.
//
// Requirements pinned here:
//   * the account exists after seeding and its password verifies with bcrypt
//   * the password is NEVER stored in plaintext
//   * seeding is idempotent — restarts never create a duplicate
//   * the seeder never creates admins/teachers and never touches an account
//     that belongs to a real user
//   * it can be disabled explicitly (SEED_DEMO_STUDENT=false)
//
// Only the MongoDB model statics are stubbed; the service and bcrypt are real.

const { test, beforeEach } = require("node:test");
const assert = require("node:assert");
const bcrypt = require("bcryptjs");
const mongoose = require("mongoose");

const User = require("../models/User");
const { ensureDemoStudent, DEMO_STUDENT, DEFAULT_DEMO_PASSWORD } = require("../services/demoAccount");

const silent = { log() {}, warn() {}, error() {} };

let store = [];

function matchCondition(user, condition) {
  const [field, value] = Object.entries(condition)[0];
  if (value instanceof RegExp) return value.test(String(user[field] || ""));
  return user[field] === value;
}

function installStubs() {
  User.findOne = async (query = {}) => {
    if (Array.isArray(query.$or)) {
      return store.find((user) => query.$or.some((condition) => matchCondition(user, condition))) || null;
    }
    if ("email" in query) return store.find((user) => matchCondition(user, query)) || null;
    if ("username" in query) return store.find((user) => matchCondition(user, query)) || null;
    return null;
  };

  // Mirrors MongoDB's upsert semantics: saving an already-known document
  // updates it, it does not insert a second copy.
  User.prototype.save = async function saveStub() {
    if (!this._id) this._id = new mongoose.Types.ObjectId();
    if (!store.includes(this)) store.push(this);
    return this;
  };
}

beforeEach(() => {
  store = [];
  delete process.env.SEED_DEMO_STUDENT;
  delete process.env.DEMO_STUDENT_PASSWORD;
  installStubs();
});

test("creates the demo student with a bcrypt hash and no plaintext password", async () => {
  const result = await ensureDemoStudent({ log: silent });

  assert.equal(result.status, "created");
  assert.equal(store.length, 1);

  const user = store[0];
  assert.equal(user.email, DEMO_STUDENT.email);
  assert.equal(user.role, "student");
  assert.match(user.password, /^\$2[aby]\$/);
  assert.equal(user.password.includes(DEFAULT_DEMO_PASSWORD), false, "plaintext must never be stored");
  assert.equal(await bcrypt.compare(DEFAULT_DEMO_PASSWORD, user.password), true);
  assert.equal(await bcrypt.compare("wrongpassword", user.password), false);
});

test("is idempotent: repeated runs never duplicate the account", async () => {
  await ensureDemoStudent({ log: silent });
  const second = await ensureDemoStudent({ log: silent });
  const third = await ensureDemoStudent({ log: silent });

  assert.equal(second.status, "already-ok");
  assert.equal(third.status, "already-ok");
  assert.equal(store.length, 1, "a restart must not create a second demo student");
});

test("repairs a demo account whose stored hash does not match the published password", async () => {
  store.push(
    new User({
      name: "Demo Student",
      username: DEMO_STUDENT.username,
      email: DEMO_STUDENT.email,
      password: "Student@12345", // plaintext left behind by an earlier manual fix
      role: "student",
    })
  );

  const result = await ensureDemoStudent({ log: silent });

  assert.equal(result.status, "password-reconciled");
  assert.equal(store.length, 1);
  assert.match(store[0].password, /^\$2[aby]\$/);
  assert.equal(await bcrypt.compare(DEFAULT_DEMO_PASSWORD, store[0].password), true);
});

test("never touches an account that belongs to a real user (role or username mismatch)", async () => {
  const admin = {
    _id: new mongoose.Types.ObjectId(),
    name: "Super Admin",
    username: "super_admin",
    email: DEMO_STUDENT.email,
    password: "unchanged-hash",
    role: "admin",
  };
  store.push(admin);

  const result = await ensureDemoStudent({ log: silent });

  assert.equal(result.status, "skipped-foreign-account");
  assert.equal(store.length, 1);
  assert.equal(store[0].password, "unchanged-hash");
  assert.equal(store[0].role, "admin", "privileges are never altered by the seeder");
});

test("can be disabled explicitly without creating anything", async () => {
  process.env.SEED_DEMO_STUDENT = "false";

  const result = await ensureDemoStudent({ log: silent });

  assert.equal(result.status, "disabled");
  assert.equal(store.length, 0);
});

test("still seeds when the demo username is already taken by another account", async () => {
  store.push({
    _id: new mongoose.Types.ObjectId(),
    name: "Someone Else",
    username: DEMO_STUDENT.username,
    email: "someone-else@example.com",
    password: "irrelevant",
    role: "student",
  });

  const result = await ensureDemoStudent({ log: silent });

  assert.equal(result.status, "created");
  assert.equal(store.length, 2);
  const demo = store.find((user) => user.email === DEMO_STUDENT.email);
  assert.ok(demo, "the demo student must exist");
  assert.notEqual(demo.username, DEMO_STUDENT.username);
  assert.equal(demo.role, "student");
});

test("DEMO_STUDENT_PASSWORD overrides the seeded password (must match the UI)", async () => {
  process.env.DEMO_STUDENT_PASSWORD = "Another@Demo1";

  const result = await ensureDemoStudent({ log: silent });

  assert.equal(result.status, "created");
  assert.equal(await bcrypt.compare("Another@Demo1", store[0].password), true);
  assert.equal(await bcrypt.compare(DEFAULT_DEMO_PASSWORD, store[0].password), false);
});
