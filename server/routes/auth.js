// server/routes/auth.js
const express = require("express");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const mongoose = require("mongoose");
const User = require("../models/User");
const {
  loginRateLimit,
  recordLoginFailure,
  recordLoginSuccess,
  getClientIp,
  normalizeEmail,
  emailHash,
} = require("../middleware/loginRateLimit");
require("dotenv").config();

const router = express.Router();

// Correlation ID for every auth request (also set globally in server.js;
// set here too so this router is safe to mount standalone, e.g. in tests).
router.use((req, res, next) => {
  req.requestId = req.requestId || crypto.randomUUID();
  res.setHeader("X-Request-Id", req.requestId);
  next();
});

function logAuth(event, fields) {
  // Structured diagnostics. Never log passwords, tokens, hashes, or full
  // emails — only a short hash of the account identifier.
  console.log(JSON.stringify({ event, ...fields }));
}

function dbConnected() {
  return mongoose.connection.readyState === 1;
}

// ==========================
// REGISTER
// ==========================
router.post("/register", async (req, res) => {
  try {
    const { name, dob, gender, username, email, password, role } = req.body;

    if (typeof email !== "string" || typeof password !== "string" || typeof username !== "string" || !email || !password || !username || email.length > 320 || username.length > 100 || password.length > 1024) {
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

    const exists = await User.findOne({
      $or: [{ email }, { username }],
    });

    if (exists) {
      return res
        .status(400)
        .json({ error: "Email or username already exists" });
    }

    // 🔐 HASH PASSWORD
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

    const token = jwt.sign(
      { id: user._id },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    res.json({
      token,
      user: {
        id: user._id,
        name: user.name,
        role: user.role,
        username: user.username,
        email: user.email,
      },
    });
  } catch (e) {
    console.error("Register error:", e.name);
    res.status(500).json({ error: "Register failed" });
  }
});

// ==========================
// LOGIN
// ==========================
// Order matters: rate limiting runs BEFORE any database work so brute-force
// traffic is rejected cheaply, and the limiter counts only FAILED attempts
// (success resets the account bucket — see middleware/loginRateLimit.js).
router.post("/login", loginRateLimit, async (req, res) => {
  const email = normalizeEmail(req);
  const clientIp = getClientIp(req);
  const baseLog = {
    requestId: req.requestId,
    emailHash: emailHash(email),
    clientIp,
  };

  try {
    const { email: rawEmail, password } = req.body;

    if (typeof rawEmail !== "string" || typeof password !== "string" || !rawEmail || !password || rawEmail.length > 320 || password.length > 1024) {
      return res.status(400).json({ error: "Missing email or password" });
    }

    // MongoDB unavailable: fail with an explicit, retryable 503 instead of
    // a misleading 500 "Login failed" (the frontend tells the user the
    // service is temporarily unavailable rather than "invalid credentials").
    if (!dbConnected()) {
      logAuth("auth.login.db_unavailable", { ...baseLog });
      return res.status(503).json({
        error: "The server is temporarily unavailable. Please try again shortly.",
        requestId: req.requestId,
      });
    }

    if (!process.env.JWT_SECRET) {
      logAuth("auth.login.misconfigured", { ...baseLog, reason: "JWT_SECRET missing" });
      return res.status(500).json({
        error: "Authentication is not configured. Please contact support.",
        requestId: req.requestId,
      });
    }

    // 🔍 find user by email or username (same lookup as before)
    const user = await User.findOne({
      $or: [{ email: rawEmail }, { username: rawEmail }]
    });

    // Unknown account and blocked account share the generic response so the
    // endpoint cannot be used to enumerate registered emails. Both count
    // toward the rate limiter exactly like a wrong password.
    if (!user || user.isBlocked) {
      recordLoginFailure(req);
      logAuth("auth.login.failure", { ...baseLog, reason: !user ? "unknown_account" : "blocked" });
      return res.status(400).json({ error: "Invalid credentials" });
    }

    // 🔐 compare hashed password
    const isMatch = await bcrypt.compare(password, user.password);

    if (!isMatch) {
      recordLoginFailure(req);
      logAuth("auth.login.failure", { ...baseLog, reason: "wrong_password" });
      return res.status(400).json({ error: "Invalid credentials" });
    }

    // 🎫 success: reset the account failure counter, then issue the token
    recordLoginSuccess(req);

    const token = jwt.sign(
      { id: user._id },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    logAuth("auth.login.success", { ...baseLog, role: user.role });

    res.json({
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        username: user.username,
      },
    });
  } catch (e) {
    // A database failure mid-request is a 503 (retryable), not a 500.
    if (!dbConnected()) {
      logAuth("auth.login.db_unavailable", { ...baseLog, error: e.name });
      return res.status(503).json({
        error: "The server is temporarily unavailable. Please try again shortly.",
        requestId: req.requestId,
      });
    }
    console.error("Login error:", e.name);
    logAuth("auth.login.error", { ...baseLog, error: e.name });
    res.status(500).json({ error: "Login failed", requestId: req.requestId });
  }
});

module.exports = router;
