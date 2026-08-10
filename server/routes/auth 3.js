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
    const { email, password } = req.body;
    console.log("LOGIN INPUT:", email);

    if (!email || !password) {
      return res.status(400).json({ error: "Missing email or password" });
    }

    // 🔍 find user
    const user = await User.findOne({ email });

    if (!user) {
      return res.status(400).json({ error: "Invalid credentials" });
    }

    // 🔐 compare hashed password
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
