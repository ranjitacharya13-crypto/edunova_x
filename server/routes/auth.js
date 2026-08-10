// server/routes/auth.js
const express = require("express");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const User = require("../models/User");
require("dotenv").config();

const router = express.Router();

// ==========================
// REGISTER
// ==========================
router.post("/register", async (req, res) => {
  try {
    const { name, dob, gender, username, email, password, role } = req.body;

    if (!email || !password || !username) {
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
    console.error("Register error:", e);
    res.status(500).json({ error: "Register failed" });
  }
});

// ==========================
// LOGIN
// ==========================
router.post("/login", async (req, res) => {
  try {
    // `email` is the established client contract; it deliberately accepts
    // either a registered email address or username for a friendlier sign-in.
    const identity = String(req.body?.email || "").trim();
    const password = String(req.body?.password || "");

    if (!identity || !password) {
      return res.status(400).json({ error: "Email or username and password are required" });
    }
    if (!process.env.JWT_SECRET) {
      console.error("[auth] JWT_SECRET is not configured");
      return res.status(503).json({ error: "Authentication is temporarily unavailable" });
    }

    // Emails are case-insensitive; usernames retain their original semantics.
    const user = await User.findOne({
      $or: [{ email: identity.toLowerCase() }, { username: identity }]
    });

    if (!user) {
      return res.status(400).json({ error: "Invalid credentials" });
    }

    if (user.isBlocked) {
      return res.status(403).json({ error: "This account has been blocked. Please contact support." });
    }

    // Passwords are bcrypt hashes; never log identities, passwords, or hashes.
    const isMatch = await bcrypt.compare(password, user.password);

    if (!isMatch) {
      return res.status(400).json({ error: "Invalid credentials" });
    }

    // 🎫 create token
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
        email: user.email,
        role: user.role,
        username: user.username,
      },
    });
  } catch (e) {
    console.error("Login error:", e);
    res.status(500).json({ error: "Login failed" });
  }
});

module.exports = router;
