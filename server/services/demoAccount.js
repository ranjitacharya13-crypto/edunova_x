// server/services/demoAccount.js
//
// Safe, idempotent provisioning for the publicly advertised Demo Student
// account (student@edunova.demo) and optional non-production dev accounts.
//
// Guarantees:
// - Enabled by default for the low-privilege demo student so the login card's
//   "Login as Demo Student" button always has a valid database record in
//   production, even when SEED_DEMO_USERS is unset or false. Set
//   SEED_DEMO_STUDENT=false to disable explicitly.
// - Passwords are ALWAYS stored as bcrypt hashes (cost 10), never plaintext.
// - Never overwrites or downgrades any account with a non-student role.
// - Reconciles a drifted password hash or accidental `isBlocked` flag on the
//   dedicated demo student account without touching other accounts.
// - Handles username collisions gracefully so a duplicate `username` index can
//   never crash server startup.

const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const User = require("../models/User");

const DEFAULT_DEMO_EMAIL = "student@edunova.demo";
const DEFAULT_DEMO_PASSWORD = "Student@12345";
const DEFAULT_DEMO_USERNAME = "student_demo_account";
const BCRYPT_HASH_RE = /^\$2[aby]\$\d{2}\$/;

function getDemoStudentSpec() {
  return {
    name: "Demo Student",
    username: DEFAULT_DEMO_USERNAME,
    email: DEFAULT_DEMO_EMAIL,
    password: process.env.DEMO_STUDENT_PASSWORD || DEFAULT_DEMO_PASSWORD,
    role: "student",
  };
}

async function resolveAvailableUsername(preferredUsername) {
  const taken = await User.findOne({ username: preferredUsername });
  if (!taken) return preferredUsername;
  const suffix = crypto.randomBytes(3).toString("hex");
  return `${preferredUsername}_${suffix}`;
}

async function ensureDemoStudent({ log = console } = {}) {
  if (String(process.env.SEED_DEMO_STUDENT || "true").trim().toLowerCase() === "false") {
    return { status: "disabled", email: DEFAULT_DEMO_EMAIL };
  }

  const spec = getDemoStudentSpec();
  const existing = await User.findOne({
    email: { $regex: /^student@edunova\.demo$/i },
  });

  if (existing) {
    // Safety guard: never modify a privileged or foreign-role account.
    if (existing.role !== "student") {
      log.warn(
        `[auth.demo] Skipping ${spec.email}: existing record has role="${existing.role}" (expected "student").`
      );
      return { status: "skipped-role-mismatch", email: existing.email };
    }

    const storedHashValid =
      typeof existing.password === "string" &&
      BCRYPT_HASH_RE.test(existing.password) &&
      (await bcrypt.compare(spec.password, existing.password).catch(() => false));

    let changed = false;
    if (!storedHashValid) {
      existing.password = await bcrypt.hash(spec.password, 10);
      changed = true;
    }
    if (existing.email !== spec.email) {
      existing.email = spec.email;
      changed = true;
    }
    if (existing.isBlocked) {
      existing.isBlocked = false;
      changed = true;
    }

    if (changed) {
      await existing.save();
      log.log(`✅ Reconciled demo student account: ${spec.email}`);
      return { status: "reconciled", email: spec.email };
    }

    return { status: "already-ok", email: spec.email };
  }

  const username = await resolveAvailableUsername(spec.username);
  const hashedPassword = await bcrypt.hash(spec.password, 10);

  const created = new User({
    name: spec.name,
    username,
    email: spec.email,
    password: hashedPassword,
    role: "student",
    isBlocked: false,
  });
  await created.save();
  log.log(`✅ Seeded demo student account: ${spec.email}`);
  return { status: "created", email: spec.email, username };
}

async function ensureDevDemoUsers({ log = console } = {}) {
  if (process.env.NODE_ENV === "production") {
    return { status: "skipped-production" };
  }
  if (String(process.env.SEED_DEMO_USERS || "").trim().toLowerCase() !== "true") {
    return { status: "disabled" };
  }

  const devUsers = [
    {
      name: "Demo Teacher",
      username: "teacher_demo",
      email: "teacher@edunova.com",
      password: process.env.DEMO_TEACHER_PASSWORD || "123456",
      role: "teacher",
    },
    {
      name: "Demo Student",
      username: "student_demo",
      email: "student@edunova.com",
      password: process.env.DEMO_DEV_STUDENT_PASSWORD || "123456",
      role: "student",
    },
  ];

  for (const demo of devUsers) {
    const existing = await User.findOne({
      email: new RegExp(`^${demo.email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i"),
    });
    if (!existing) {
      const username = await resolveAvailableUsername(demo.username);
      const hashedPassword = await bcrypt.hash(demo.password, 10);
      await new User({
        name: demo.name,
        username,
        email: demo.email,
        password: hashedPassword,
        role: demo.role,
        isBlocked: false,
      }).save();
      log.log(`✅ Seeded non-production demo user: ${demo.email} (${demo.role})`);
    } else if (existing.role === demo.role) {
      const matches =
        BCRYPT_HASH_RE.test(String(existing.password || "")) &&
        (await bcrypt.compare(demo.password, existing.password).catch(() => false));
      if (!matches || existing.isBlocked) {
        existing.password = await bcrypt.hash(demo.password, 10);
        existing.isBlocked = false;
        await existing.save();
        log.log(`✅ Reconciled non-production demo user: ${demo.email}`);
      }
    }
  }

  return { status: "ok" };
}

module.exports = {
  ensureDemoStudent,
  ensureDevDemoUsers,
  getDemoStudentSpec,
  DEFAULT_DEMO_EMAIL,
  DEFAULT_DEMO_PASSWORD,
  DEFAULT_DEMO_USERNAME,
};
