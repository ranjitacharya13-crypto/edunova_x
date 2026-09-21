// server/routes/auth.js
//
// Authentication. Two hard rules enforced here:
//
//   1. Status codes tell the truth:
//        400 = malformed / missing request data
//        401 = the credentials are wrong (unknown email, wrong password, blocked)
//        500 = the server is misconfigured (e.g. JWT_SECRET missing)
//        503 = a dependency (MongoDB) is unavailable
//      A failed login is NEVER reported as 400, and a broken server/database is
//      NEVER reported as "Invalid credentials".
//   2. The password is only ever checked with bcrypt.compare(raw, storedHash).
//      The supplied password is never hashed and compared against the stored
//      hash, and passwords are never logged.
const express = require("express");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const User = require("../models/User");
const database = require("../services/database");
const requireAuth = require("../middleware/auth");
require("dotenv").config();

const router = express.Router();

const MAX_EMAIL_LENGTH = 320;
const MAX_PASSWORD_LENGTH = 1024;
const MAX_USERNAME_LENGTH = 100;

// ONE generic message for every credential failure: the API never discloses
// whether a particular email exists in the database (no account enumeration).
const INVALID_CREDENTIALS = "Invalid credentials";

// A valid bcrypt hash of an unrelated throwaway value. It is used ONLY to spend
// the same bcrypt time on "unknown user" as on a real password check, so the
// response timing cannot be used to enumerate accounts. It is never compared
// against a user-supplied password for authentication purposes.
const TIMING_DUMMY_HASH =
  "$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy";

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// `student@edunova.demo` → `s***@edunova.demo`. Keeps operational logs useful
// without writing full addresses (and never a password) to the service logs.
function maskIdentifier(value) {
  const text = String(value || "");
  const at = text.indexOf("@");
  if (!text) return "";
  if (at <= 0) return `${text.slice(0, 1)}***`;
  return `${text.slice(0, 1)}***${text.slice(at)}`;
}

// The project's existing JWT structure: only the user id is signed. The role is
// always re-read from MongoDB by middleware/auth.js, so a role change takes
// effect immediately instead of waiting for the token to expire.
function signToken(user) {
  return jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: "7d" });
}

function safeUser(user) {
  return {
    id: user._id,
    name: user.name,
    email: user.email,
    role: user.role,
    username: user.username,
  };
}

// Shared pre-checks: a missing signing secret or a dead database is a SERVER
// problem and must never be answered as a credential failure.
function serverProblem() {
  if (!process.env.JWT_SECRET) {
    return {
      status: 500,
      error: "Server configuration error: authentication is not configured (JWT_SECRET missing)",
    };
  }
  if (!database.isDatabaseReady()) {
    return {
      status: 503,
      error: `Database unavailable (${database.databaseState()}). Please try again in a moment.`,
    };
  }
  return null;
}

// Login accepts the email address or the username in the same field. Matching
// is exact first, then case-insensitive for the email (or the address: MongoDB's
// unique index is case-sensitive while email addresses are not).
async function findUserByIdentifier(identifier) {
  const user = await User.findOne({
    $or: [{ email: identifier }, { username: identifier }],
  });
  if (user) return user;
  if (!identifier.includes("@")) return null;
  return User.findOne({ email: new RegExp(`^${escapeRegex(identifier)}$`, "i") });
}

// ==========================
// REGISTER
// ==========================
router.post("/register", async (req, res) => {
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const { name, dob, gender, role } = body;
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const username = typeof body.username === "string" ? body.username.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";

    if (
      !email ||
      !password ||
      !username ||
      email.length > MAX_EMAIL_LENGTH ||
      username.length > MAX_USERNAME_LENGTH ||
      password.length > MAX_PASSWORD_LENGTH
    ) {
      return res.status(400).json({ error: "Missing fields" });
    }

    if (role === "admin") {
      return res.status(403).json({ error: "Admin account cannot be created" });
    }

    const allowedRoles = ["student", "teacher"];
    const selectedRole = role || "student";
    if (!allowedRoles.includes(selectedRole)) {
      return res.status(400).json({ error: "Invalid role" });
    }

    const problem = serverProblem();
    if (problem) {
      console.error(`REGISTER_FAILED reason=server_problem status=${problem.status}`);
      return res.status(problem.status).json({ error: problem.error });
    }

    const exists = await User.findOne({
      $or: [{ email }, { username }],
    });

    if (exists) {
      return res.status(400).json({ error: "Email or username already exists" });
    }

    // 🔐 HASH PASSWORD (bcrypt, same cost factor as the demo seed)
    const hashedPassword = await bcrypt.hash(password, 10);

    const user = new User({
      name,
      dob,
      gender,
      username,
      email,
      password: hashedPassword,
      role: selectedRole,
    });

    await user.save();

    res.json({ token: signToken(user), user: safeUser(user) });
  } catch (e) {
    console.error("Register error:", e.name);
    res.status(500).json({ error: "Register failed" });
  }
});

// ==========================
// LOGIN
// ==========================
router.post("/login", async (req, res) => {
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const email = typeof body.email === "string" ? body.email.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";

    // ---- 400: malformed / incomplete REQUEST (never a credential verdict) ---
    if (!email || !password || email.length > MAX_EMAIL_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
      console.warn("LOGIN_REJECTED reason=missing_or_invalid_fields");
      return res.status(400).json({ error: "Email and password are required" });
    }

    // ---- 500/503: the server itself cannot authenticate anyone right now ----
    const problem = serverProblem();
    if (problem) {
      console.error(`LOGIN_FAILED reason=server_problem status=${problem.status} detail=${problem.error}`);
      return res.status(problem.status).json({ error: problem.error });
    }

    const user = await findUserByIdentifier(email);

    if (!user || user.isBlocked) {
      // Spend the same bcrypt time as a real comparison (timing safety).
      await bcrypt.compare(password, TIMING_DUMMY_HASH);
      console.warn(
        `LOGIN_FAILED reason=${user ? "blocked_account" : "user_not_found"} identifier=${maskIdentifier(email)}`
      );
      return res.status(401).json({ error: INVALID_CREDENTIALS });
    }

    // ---- 401: the password does not match the stored bcrypt hash -------------
    const isMatch = await bcrypt.compare(password, String(user.password || ""));
    if (!isMatch) {
      console.warn(`LOGIN_FAILED reason=password_mismatch identifier=${maskIdentifier(email)}`);
      return res.status(401).json({ error: INVALID_CREDENTIALS });
    }

    // 🎫 token is only generated AFTER the password was verified
    res.json({ token: signToken(user), user: safeUser(user) });
  } catch (e) {
    // Database/query failure: a server problem, not a bad password.
    console.error("LOGIN_FAILED reason=exception name=" + (e && e.name));
    res.status(500).json({ error: "Login failed" });
  }
});

// ==========================
// CURRENT SESSION
// ==========================
// Lets the SPA restore a session after a reload. The middleware verifies the
// JWT signature AND that the user still exists in MongoDB, so the frontend only
// ever claims "signed in" for a session the backend has just re-validated.
router.get("/me", requireAuth, (req, res) => {
  res.json({ user: req.user });
});

module.exports = router;
