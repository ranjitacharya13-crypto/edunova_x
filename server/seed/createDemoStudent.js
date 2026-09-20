// server/seed/createDemoStudent.js
//
// Creates the demo student account used for project demonstrations:
//
//   Email:    student@edunova.demo
//   Password: Student@12345
//   Role:     student
//   Name:     Demo Student
//
// The script is IDEMPOTENT — running it multiple times never creates a
// duplicate account and never touches any other user (admins, teachers or
// existing students).
//
// Usage:
//   node server/seed/createDemoStudent.js
//   npm run seed:demo-student --prefix server
//
// Environment:
//   MONGO_URI   (required) existing MongoDB connection string.
//               Loaded from server/.env when present, or from the shell.
//   DEMO_STUDENT_PASSWORD (optional) override the default demo password.
//
// Nothing is hardcoded: the MongoDB URI always comes from the environment and
// the password is stored ONLY as a bcrypt hash (same bcryptjs mechanism and
// cost factor used by server/routes/auth.js).
const path = require("path");

// Load server/.env when running locally (Render/production inject env vars).
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const User = require("../models/User");

const DEMO_STUDENT = {
  name: "Demo Student",
  username: "student_demo_account",
  email: "student@edunova.demo",
  password: process.env.DEMO_STUDENT_PASSWORD || "Student@12345",
  role: "student",
};

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
    const existing = await User.findOne({ email: DEMO_STUDENT.email });

    if (existing) {
      if (existing.role !== "student") {
        console.error(
          `❌ A user with email ${DEMO_STUDENT.email} already exists but has role "${existing.role}" (expected "student"). Nothing was changed — please resolve this manually.`
        );
        process.exitCode = 1;
        return;
      }
      console.log(
        `ℹ️  Demo student already exists: ${existing.email} (role: ${existing.role}). Nothing to do.`
      );
      return;
    }

    // Same bcrypt mechanism + cost factor as the register route.
    const hashedPassword = await bcrypt.hash(DEMO_STUDENT.password, 10);

    const user = new User({
      name: DEMO_STUDENT.name,
      username: DEMO_STUDENT.username,
      email: DEMO_STUDENT.email,
      password: hashedPassword,
      role: DEMO_STUDENT.role,
    });
    await user.save();

    console.log(`✅ Demo student created: ${user.email} (role: ${user.role})`);
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
