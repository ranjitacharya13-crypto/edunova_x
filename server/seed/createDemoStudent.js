// server/seed/createDemoStudent.js
//
// Creates or reconciles the demo student account used for project demonstrations:
//
//   Email:    student@edunova.demo
//   Password: Student@12345 (or DEMO_STUDENT_PASSWORD)
//   Role:     student
//   Name:     Demo Student
//
// Idempotent: never duplicates the account, repairs drifted demo password
// hashes, and never modifies any non-student account.
const path = require("path");

require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const mongoose = require("mongoose");
const { ensureDemoStudent, getDemoStudentSpec } = require("../services/demoAccount");

const DEMO_STUDENT = getDemoStudentSpec();

async function createDemoStudent() {
  const mongoUri = String(process.env.MONGO_URI || "").trim();
  if (!mongoUri) {
    console.error(
      "❌ MONGO_URI is not set. Set it in server/.env or export it before running the seed."
    );
    process.exitCode = 1;
    return;
  }

  await mongoose.connect(mongoUri, { serverSelectionTimeoutMS: 15000 });
  console.log("✅ Connected to MongoDB");

  try {
    // CLI invocation explicitly intends to provision the demo student even if
    // SEED_DEMO_STUDENT=false happened to be set in the shell.
    const previousFlag = process.env.SEED_DEMO_STUDENT;
    process.env.SEED_DEMO_STUDENT = "true";
    let result;
    try {
      result = await ensureDemoStudent({ log: console });
    } finally {
      if (previousFlag === undefined) delete process.env.SEED_DEMO_STUDENT;
      else process.env.SEED_DEMO_STUDENT = previousFlag;
    }

    if (result.status === "skipped-role-mismatch") {
      console.error(
        `❌ Account ${DEMO_STUDENT.email} exists with a non-student role. Nothing was changed.`
      );
      process.exitCode = 1;
      return;
    }

    if (result.status === "already-ok") {
      console.log(
        `ℹ️  Demo student already exists and verified: ${DEMO_STUDENT.email} (role: student).`
      );
    }
  } finally {
    await mongoose.connection.close();
    console.log("🔌 MongoDB connection closed");
  }
}

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
