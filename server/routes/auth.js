// server/routes/auth.js
const express = require("express");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const mongoose = require("mongoose");
const User = require("../models/User");
const auth = require("../middleware/auth");
const {
  loginRateLimit,
  recordLoginFailure,
  recordLoginSuccess,
  resolveClientIdentity,
  maskClientIp,
  normalizeEmail,
  emailHash,
} = require("../middleware/loginRateLimit");
require("dotenv").config();

const router = express.Router();

// Pre-computed bcrypt hash used when an account does not exist so unknown
// emails and wrong passwords take identical bcrypt CPU time (prevents timing
// enumeration).
const DUMMY_PASSWORD_HASH = bcrypt.hashSync("edunova-constant-time-guard-hash", 10);

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function safeRequestId(raw) {
  const cleaned = String(raw || "").trim();
  return /^[a-zA-Z0-9._-]{8,64}$/.test(cleaned) ? cleaned : crypto.randomUUID();
}

router.use((req, res, next) => {
  req.requestId = req.requestId || safeRequestId(req.headers["x-request-id"]);
  res.setHeader("X-Request-Id", req.requestId);
  next();
});

function logAuth(event, fields) {
  // Structured, secret-free diagnostics. Never log passwords, JWTs, password
  // hashes, raw emails, or raw unmasked user IP addresses.
  console.log(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      event,
      ...fields,
    })
  );
}

function dbConnected() {
  return mongoose.connection.readyState === 1;
}

// ==========================
// REGISTER
// ==========================
router.post("/register", async (req, res) => {
  const startedAt = Date.now();
  const clientIdentity = resolveClientIdentity(req);
  const rawEmail = typeof req.body?.email === "string" ? req.body.email.trim() : "";
  const cleanEmail = rawEmail.toLowerCase();
  const baseLog = {
    requestId: req.requestId,
    accountRef: emailHash(cleanEmail),
    clientId: maskClientIp(clientIdentity.ip),
    ipSource: clientIdentity.source,
  };

  try {
    const { name, dob, gender, username, password, role } = req.body || {};
    const cleanUsername = typeof username === "string" ? username.trim() : "";

    if (
      typeof req.body?.email !== "string" ||
      typeof password !== "string" ||
      typeof username !== "string" ||
      !cleanEmail ||
      !password ||
      !cleanUsername ||
      cleanEmail.length > 320 ||
      cleanUsername.length > 100 ||
      password.length > 1024
    ) {
      logAuth("auth.register.bad_request", {
        ...baseLog,
        status: 400,
        durationMs: Date.now() - startedAt,
      });
      return res.status(400).json({ error: "Missing fields", requestId: req.requestId });
    }

    if (role === "admin") {
      logAuth("auth.register.forbidden_role", {
        ...baseLog,
        status: 403,
        durationMs: Date.now() - startedAt,
      });
      return res.status(403).json({ error: "Admin account cannot be created", requestId: req.requestId });
    }

    const allowedRoles = ["student", "teacher"];
    const selectedRole = role || "student";
    if (!allowedRoles.includes(selectedRole)) {
      logAuth("auth.register.invalid_role", {
        ...baseLog,
        status: 400,
        durationMs: Date.now() - startedAt,
      });
      return res.status(400).json({ error: "Invalid role", requestId: req.requestId });
    }

    if (!dbConnected()) {
      logAuth("auth.register.db_unavailable", {
        ...baseLog,
        status: 503,
        durationMs: Date.now() - startedAt,
      });
      return res.status(503).json({
        error: "The server is temporarily unavailable. Please try again shortly.",
        requestId: req.requestId,
      });
    }

    if (!process.env.JWT_SECRET) {
      logAuth("auth.register.misconfigured", {
        ...baseLog,
        status: 500,
        reason: "JWT_SECRET missing",
      });
      return res.status(500).json({
        error: "Authentication is not configured. Please contact support.",
        requestId: req.requestId,
      });
    }

    const exactEmailRegex = new RegExp(`^${escapeRegex(cleanEmail)}$`, "i");
    const exists = await User.findOne({
      $or: [{ email: cleanEmail }, { email: exactEmailRegex }, { username: cleanUsername }],
    });

    if (exists) {
      logAuth("auth.register.conflict", {
        ...baseLog,
        status: 400,
        durationMs: Date.now() - startedAt,
      });
      return res
        .status(400)
        .json({ error: "Email or username already exists", requestId: req.requestId });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const user = new User({
      name: typeof name === "string" ? name.trim() : name,
      dob,
      gender,
      username: cleanUsername,
      email: cleanEmail,
      password: hashedPassword,
      role: selectedRole,
    });

    await user.save();

    const token = jwt.sign(
      { id: user._id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    logAuth("auth.register.success", {
      ...baseLog,
      status: 200,
      role: user.role,
      durationMs: Date.now() - startedAt,
    });

    return res.status(200).json({
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
    if (!dbConnected()) {
      logAuth("auth.register.db_unavailable", {
        ...baseLog,
        status: 503,
        error: e?.name || "DatabaseError",
        durationMs: Date.now() - startedAt,
      });
      return res.status(503).json({
        error: "The server is temporarily unavailable. Please try again shortly.",
        requestId: req.requestId,
      });
    }
    logAuth("auth.register.error", {
      ...baseLog,
      status: 500,
      error: e?.name || "RegisterError",
      durationMs: Date.now() - startedAt,
    });
    return res.status(500).json({ error: "Register failed", requestId: req.requestId });
  }
});

// ==========================
// LOGIN
// ==========================
// Middleware order:
// 1. Correlation ID assigned above.
// 2. `loginRateLimit` enforces temporary per-(account, IP), per-IP, and
//    distributed-account lockouts BEFORE any database query or bcrypt work.
// 3. Only failed credential checks increment failure counters; successful
//    sign-in resets the caller's account failure counter immediately.
router.post("/login", loginRateLimit, async (req, res) => {
  const startedAt = Date.now();
  const email = normalizeEmail(req);
  const clientIdentity = req.authClientIdentity || resolveClientIdentity(req);
  const baseLog = {
    requestId: req.requestId,
    accountRef: emailHash(email),
    clientId: maskClientIp(clientIdentity.ip),
    ipSource: clientIdentity.source,
    isSharedProxy: clientIdentity.isSharedProxy,
    store: req.authRateLimitStore || "memory",
  };

  try {
    const rawEmail = req.body?.email;
    const password = req.body?.password;
    const identifier = typeof rawEmail === "string" ? rawEmail.trim() : "";

    if (
      typeof rawEmail !== "string" ||
      typeof password !== "string" ||
      !identifier ||
      !password ||
      identifier.length > 320 ||
      password.length > 1024
    ) {
      logAuth("auth.login.bad_request", {
        ...baseLog,
        status: 400,
        reason: "missing_or_invalid_fields",
        durationMs: Date.now() - startedAt,
      });
      return res.status(400).json({
        error: "Missing email or password",
        requestId: req.requestId,
      });
    }

    if (!dbConnected()) {
      logAuth("auth.login.db_unavailable", {
        ...baseLog,
        status: 503,
        durationMs: Date.now() - startedAt,
      });
      return res.status(503).json({
        error: "The server is temporarily unavailable. Please try again shortly.",
        requestId: req.requestId,
      });
    }

    if (!process.env.JWT_SECRET) {
      logAuth("auth.login.misconfigured", {
        ...baseLog,
        status: 500,
        reason: "JWT_SECRET missing",
        durationMs: Date.now() - startedAt,
      });
      return res.status(500).json({
        error: "Authentication is not configured. Please contact support.",
        requestId: req.requestId,
      });
    }

    const normalizedEmail = identifier.toLowerCase();
    const exactEmailRegex = new RegExp(`^${escapeRegex(normalizedEmail)}$`, "i");
    const user = await User.findOne({
      $or: [
        { email: normalizedEmail },
        { email: exactEmailRegex },
        { username: identifier },
      ],
    });

    const candidateHash =
      user && typeof user.password === "string" && user.password
        ? user.password
        : DUMMY_PASSWORD_HASH;
    const isMatch = await bcrypt.compare(password, candidateHash).catch(() => false);

    if (!user || !isMatch) {
      await recordLoginFailure(req);
      logAuth("auth.login.failure", {
        ...baseLog,
        status: 401,
        reason: !user ? "unknown_account" : "wrong_password",
        durationMs: Date.now() - startedAt,
      });
      return res.status(401).json({
        error: "Invalid credentials",
        requestId: req.requestId,
      });
    }

    if (user.isBlocked) {
      await recordLoginFailure(req);
      logAuth("auth.login.failure", {
        ...baseLog,
        status: 403,
        reason: "account_blocked",
        durationMs: Date.now() - startedAt,
      });
      return res.status(403).json({
        error: "Your account has been suspended. Please contact an administrator.",
        code: "ACCOUNT_BLOCKED",
        requestId: req.requestId,
      });
    }

    await recordLoginSuccess(req, [user.email, user.username]);

    const token = jwt.sign(
      { id: user._id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    logAuth("auth.login.success", {
      ...baseLog,
      status: 200,
      role: user.role,
      durationMs: Date.now() - startedAt,
    });

    return res.status(200).json({
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
    if (!dbConnected()) {
      logAuth("auth.login.db_unavailable", {
        ...baseLog,
        status: 503,
        error: e?.name || "DatabaseError",
        durationMs: Date.now() - startedAt,
      });
      return res.status(503).json({
        error: "The server is temporarily unavailable. Please try again shortly.",
        requestId: req.requestId,
      });
    }
    logAuth("auth.login.error", {
      ...baseLog,
      status: 500,
      error: e?.name || "LoginError",
      durationMs: Date.now() - startedAt,
    });
    return res.status(500).json({ error: "Login failed", requestId: req.requestId });
  }
});

// ==========================
// CURRENT SESSION (/api/auth/me)
// ==========================
router.get("/me", auth, (req, res) => {
  return res.status(200).json({
    user: {
      id: req.user.id,
      name: req.user.name,
      email: req.user.email,
      role: req.user.role,
      username: req.user.username || "",
    },
  });
});

module.exports = router;
