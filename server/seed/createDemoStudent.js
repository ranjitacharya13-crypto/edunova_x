// server/seed/createDemoStudent.js
//
// Creates/repairs the demo student account used for project demonstrations:
//
//   Email:    student@edunova.demo
//   Password: Student@12345
//   Role:     student
//   Name:     Demo Student
//
// The account itself is provisioned by `server/services/demoAccount.js`, which
// also runs automatically on every server start (so production can never serve
// a login page whose demo credentials do not exist). This script is the manual
// entry point for the same idempotent operation:
//
//   node server/seed/createDemoStudent.js
//   npm run seed:demo-student --prefix server
//
// It never creates a duplicate (findOne first), never touches any other user
// (admins, teachers, students), never creates an admin, and stores the password
// ONLY as a bcrypt hash produced with the same library and cost factor used by
// the register/login routes (bcryptjs, cost 10).
//
// Environment:
//   MONGO_URI              (required) MongoDB connection string.
//                          Loaded from server/.env when present, or the shell.
//   DEMO_STUDENT_PASSWORD  (optional) override the published demo password.
//                          Must match what the login page shows.
//   SEED_DEMO_STUDENT=false (optional) makes this script a no-op.
const path = require("path");

// Load server/.env when running locally (Render/production inject env vars).
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const mongoose = require("mongoose");
const { ensureDemoStudent, DEMO_STUDENT } = require("../services/demoAccount");

async function createDemoStudent() {
  const mongoUri = String(process.env.MONGO_URI || "").trim();
  if (!mongoUri) {
    console.error(
      "❌ MONGO_URI is not set. Set it in server/.env or export it before running the seed."
    );
    process.exitCode = 1;
    return { status: "missing-config" };
  }

  await mongoose.connect(mongoUri, { serverSelectionTimeoutMS: 15000 });
  console.log("✅ Connected to MongoDB");

  try {
    const result = await ensureDemoStudent();
    if (result.status === "skipped-foreign-account") {
      process.exitCode = 1;
    }
    return result;
  } finally {
    await mongoose.connection.close();
    console.log("🔌 MongoDB connection closed");
  }
}

// Allow `require()` without side effects (useful for tests).
if (require.main === module) {
  createDemoStudent().catch(async (err) => {
    console.error("❌ Failed to create demo student:", err.message);
    try {
      await mongoose.connection.close();
    } catch {
      /* already closed */
    }
    process.exit(1);
  });
}

module.exports = { createDemoStudent, DEMO_STUDENT };
