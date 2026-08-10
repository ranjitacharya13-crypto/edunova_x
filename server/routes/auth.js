const express = require("express");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const mongoose = require("mongoose");
const User = require("../models/User");

const router = express.Router();
const TOKEN_EXPIRY = process.env.JWT_EXPIRES_IN || "7d";

function clean(value, maxLength = 254) {
  return String(value || "").trim().slice(0, maxLength);
}

function authUnavailable(res) {
  return res.status(503).json({
    error: "Authentication is temporarily unavailable. Please try again shortly.",
    code: "AUTH_UNAVAILABLE",
  });
}

function createToken(user) {
  return jwt.sign({ id: user._id, role: user.role }, process.env.JWT_SECRET, { expiresIn: TOKEN_EXPIRY });
}

function userPayload(user) {
  return {
    id: user._id,
    name: user.name,
    email: user.email,
    role: user.role,
    username: user.username,
  };
}

function databaseReady() {
  return mongoose.connection.readyState === 1;
}

// ==========================
// REGISTER
// ==========================
router.post("/register", async (req, res) => {
  try {
    const name = clean(req.body?.name, 120);
    const dob = clean(req.body?.dob, 32);
    const gender = clean(req.body?.gender, 32);
    const username = clean(req.body?.username, 64);
    const email = clean(req.body?.email).toLowerCase();
    const password = String(req.body?.password || "");
    const role = clean(req.body?.role, 20) || "student";

    if (!email || !username || !password) {
      return res.status(400).json({ error: "Email, username, and password are required.", code: "MISSING_FIELDS" });
    }
    if (!/^\S+@\S+\.\S+$/.test(email)) {
      return res.status(400).json({ error: "Enter a valid email address.", code: "INVALID_EMAIL" });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: "Password must contain at least 6 characters.", code: "WEAK_PASSWORD" });
    }
    if (role === "admin") return res.status(403).json({ error: "Admin accounts cannot be created here.", code: "ADMIN_REGISTRATION_FORBIDDEN" });
    if (!["student", "teacher"].includes(role)) return res.status(400).json({ error: "Select a valid role.", code: "INVALID_ROLE" });
    if (!databaseReady() || !process.env.JWT_SECRET) return authUnavailable(res);

    const exists = await User.findOne({ $or: [{ email }, { username }] }).lean();
    if (exists) return res.status(409).json({ error: "An account with that email or username already exists.", code: "ACCOUNT_EXISTS" });

    const passwordHash = await bcrypt.hash(password, 12);
    const user = await User.create({ name, dob, gender, username, email, password: passwordHash, role });
    return res.status(201).json({ token: createToken(user), user: userPayload(user) });
  } catch (error) {
    if (error?.code === 11000) return res.status(409).json({ error: "An account with that email or username already exists.", code: "ACCOUNT_EXISTS" });
    console.error("[auth] registration failed:", error.message);
    return res.status(500).json({ error: "Unable to create the account right now.", code: "REGISTRATION_FAILED" });
  }
});

// ==========================
// LOGIN
// Contract compatibility: existing web builds send `email`, while the UI calls
// the field an identifier because usernames are supported too.
// ==========================
router.post("/login", async (req, res) => {
  try {
    const identifier = clean(req.body?.identifier || req.body?.email, 254);
    const password = String(req.body?.password || "");
    if (!identifier || !password) {
      return res.status(400).json({ error: "Email or username and password are required.", code: "MISSING_CREDENTIALS" });
    }
    if (!databaseReady() || !process.env.JWT_SECRET) return authUnavailable(res);

    const user = await User.findOne({
      $or: [{ email: identifier.toLowerCase() }, { username: identifier }],
    });

    // Use one controlled response for an unknown identifier and a bad password
    // so the API does not disclose which accounts exist.
    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(401).json({ error: "Invalid email/username or password.", code: "INVALID_CREDENTIALS" });
    }
    if (user.isBlocked) {
      return res.status(403).json({ error: "This account has been disabled. Contact an administrator for help.", code: "ACCOUNT_BLOCKED" });
    }

    return res.status(200).json({ token: createToken(user), user: userPayload(user) });
  } catch (error) {
    console.error("[auth] login failed:", error.message);
    return res.status(500).json({ error: "Unable to sign in right now. Please try again shortly.", code: "LOGIN_FAILED" });
  }
});

module.exports = router;
