// server/services/demoAccount.js
//
// Idempotent provisioning of the demo STUDENT account that the login page
// advertises ("Login as Demo Student"):
//
//     email:    student@edunova.demo
//     password: Student@12345      (stored ONLY as a bcrypt hash)
//     role:     student
//     name:     Demo Student
//
// The demo button in the UI calls the real POST /api/auth/login endpoint and
// therefore only works when this exact record exists in the deployed MongoDB
// database. Previously the record was only created when
// `NODE_ENV !== "production" && SEED_DEMO_USERS === "true"`, which is never the
// case on Render (NODE_ENV=production, SEED_DEMO_USERS=false) — so production
// logins failed with "Invalid credentials" even though the credentials were
// printed on the page. This module makes that impossible:
//
//   * runs on every server start (after MongoDB connects) AND via
//     `npm run seed:demo-student`;
//   * is idempotent — `findOne` first, so restarts never duplicate the account;
//   * only ever touches this one demo student: it never creates admins or
//     teachers and never elevates privileges;
//   * refuses to modify an account that belongs to a real user (different
//     role or a different username on the same email);
//   * stores the password with the same bcrypt library and cost factor the
//     register/login routes use (bcryptjs, cost 10) and verifies it with
//     `bcrypt.compare(raw, hash)` — never by comparing two hashes;
//   * opt out with SEED_DEMO_STUDENT=false (then the documented demo login
//     legitimately fails with 401 — there is no fake login path).
const bcrypt = require("bcryptjs");
const User = require("../models/User");

const DEMO_STUDENT = {
  name: "Demo Student",
  username: "student_demo_account",
  email: "student@edunova.demo",
  role: "student",
};

// The password shown on the login card. Overridable for non-production
// environments only; if it is overridden the UI must be updated to match, so
// the override is logged loudly.
const DEFAULT_DEMO_PASSWORD = "Student@12345";

// Same cost factor as server/routes/auth.js (register) — hashes stay compatible.
const BCRYPT_COST = 10;

function demoPassword() {
  const override = String(process.env.DEMO_STUDENT_PASSWORD || "").trim();
  return override || DEFAULT_DEMO_PASSWORD;
}

function isEnabled() {
  const raw = process.env.SEED_DEMO_STUDENT;
  if (raw === undefined || String(raw).trim() === "") return true;
  return !["false", "0", "no", "off"].includes(String(raw).trim().toLowerCase());
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Case-insensitive lookup: an address stored with different casing is still
// the same account (MongoDB's unique index is case-sensitive).
async function findDemoStudent() {
  const exact = await User.findOne({ email: DEMO_STUDENT.email });
  if (exact) return exact;
  return User.findOne({ email: new RegExp(`^${escapeRegex(DEMO_STUDENT.email)}$`, "i") });
}

// The account's username is only cosmetic (login accepts email OR username),
// but it must be unique. If another account already holds it, pick a free
// variant instead of failing the seed with a duplicate-key error.
async function availableUsername() {
  const base = DEMO_STUDENT.username;
  const candidates = [base, `${base}_1`, `${base}_2`, `${base}_3`];
  for (const candidate of candidates) {
    const clash = await User.findOne({ username: candidate });
    if (!clash) return candidate;
  }
  return `${base}_${Date.now().toString(36)}`;
}

/**
 * Ensure the documented demo student exists and can authenticate with the
 * published demo password.
 *
 * @returns {Promise<{status: string, email: string}>}
 *   status: created | already-ok | password-reconciled | disabled | skipped-foreign-account
 */
async function ensureDemoStudent({ log = console } = {}) {
  if (!isEnabled()) {
    log.log("ℹ️  Demo student seeding disabled (SEED_DEMO_STUDENT=false).");
    return { status: "disabled", email: DEMO_STUDENT.email };
  }

  const password = demoPassword();
  if (password !== DEFAULT_DEMO_PASSWORD) {
    log.warn(
      "⚠️  DEMO_STUDENT_PASSWORD is set: the demo account is seeded with the " +
        "configured password, which must match the password shown on the login page."
    );
  }

  const existing = await findDemoStudent();

  if (existing) {
    const isSameDemoAccount =
      existing.role === "student" &&
      (!existing.username || existing.username === DEMO_STUDENT.username || String(existing.username).startsWith(DEMO_STUDENT.username));

    if (!isSameDemoAccount) {
      log.warn(
        `⚠️  ${DEMO_STUDENT.email} already belongs to a different account ` +
          `(role "${existing.role}", username "${existing.username}"). Nothing was changed — ` +
          "resolve this manually if the demo login must work."
      );
      return { status: "skipped-foreign-account", email: DEMO_STUDENT.email };
    }

    const matches = await bcrypt.compare(password, String(existing.password || ""));
    if (matches) {
      log.log(`✅ Demo student ready: ${existing.email}`);
      return { status: "already-ok", email: existing.email };
    }

    // The record exists but its hash does not match the published demo
    // password (manually created user, stale hash, or a plaintext value).
    // Re-hash ONLY this demo account; the password is still verified with
    // bcrypt.compare on every login afterwards.
    existing.password = await bcrypt.hash(password, BCRYPT_COST);
    await existing.save();
    log.warn(
      `🔐 Demo student password hash did not match the published demo password — ` +
        `it was re-hashed for ${existing.email} (bcrypt, cost ${BCRYPT_COST}).`
    );
    return { status: "password-reconciled", email: existing.email };
  }

  const hashedPassword = await bcrypt.hash(password, BCRYPT_COST);
  const username = await availableUsername();

  try {
    const user = new User({
      name: DEMO_STUDENT.name,
      username,
      email: DEMO_STUDENT.email,
      password: hashedPassword,
      role: DEMO_STUDENT.role,
    });
    await user.save();
    log.log(`✅ Seeded demo student: ${user.email} (role: ${user.role})`);
    return { status: "created", email: user.email };
  } catch (error) {
    // A racing deployment (or a leftover index entry) can still trip a unique
    // key. Re-read instead of creating a duplicate.
    if (error && error.code === 11000) {
      const raced = await findDemoStudent();
      if (raced) {
        log.log(`✅ Demo student already present: ${raced.email}`);
        return { status: "already-ok", email: raced.email };
      }
    }
    throw error;
  }
}

module.exports = { ensureDemoStudent, DEMO_STUDENT, DEFAULT_DEMO_PASSWORD, BCRYPT_COST };
