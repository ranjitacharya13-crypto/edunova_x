// server/middleware/auth.js
const jwt = require("jsonwebtoken");
const User = require("../models/User");
require("dotenv").config();

function logTokenEvent(event, req, extra = {}) {
  console.warn(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      event,
      requestId: req.requestId || null,
      ...extra,
    })
  );
}

module.exports = async function authMiddleware(req, res, next) {
  const authHeader = req.headers["authorization"] || req.headers["Authorization"];
  const token =
    typeof authHeader === "string" && authHeader.startsWith("Bearer ")
      ? authHeader.slice(7).trim()
      : null;

  if (!token) {
    return res.status(401).json({ error: "No token provided", code: "NO_TOKEN" });
  }

  if (!process.env.JWT_SECRET) {
    logTokenEvent("auth.token.misconfigured", req, { status: 500 });
    return res.status(500).json({
      error: "Authentication is not configured",
      code: "AUTH_MISCONFIGURED",
    });
  }

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch (e) {
    if (e && e.name === "TokenExpiredError") {
      logTokenEvent("auth.token.expired", req, { status: 401 });
      return res.status(401).json({
        error: "Session expired. Please sign in again.",
        code: "TOKEN_EXPIRED",
      });
    }
    logTokenEvent("auth.token.invalid", req, { status: 401, error: e?.name || "InvalidToken" });
    return res.status(401).json({ error: "Invalid token", code: "INVALID_TOKEN" });
  }

  try {
    const user = await User.findById(decoded.id).select("-password");
    if (!user) {
      logTokenEvent("auth.token.user_not_found", req, { status: 401 });
      return res.status(401).json({ error: "Invalid or expired session", code: "USER_NOT_FOUND" });
    }
    if (user.isBlocked) {
      logTokenEvent("auth.token.blocked", req, { status: 403 });
      return res.status(403).json({
        error: "Your account has been suspended. Please contact an administrator.",
        code: "ACCOUNT_BLOCKED",
      });
    }

    req.user = {
      id: user._id,
      email: user.email,
      username: user.username || "",
      role: user.role,
      name: user.name,
      enrolledClasses: user.enrolledClasses || [],
      subjects: user.subjects || [],
      timezone: user.timezone || "UTC",
    };
    return next();
  } catch (e) {
    logTokenEvent("auth.token.db_error", req, { status: 503, error: e?.name || "DatabaseError" });
    return res.status(503).json({
      error: "The server is temporarily unavailable. Please try again shortly.",
      code: "DB_UNAVAILABLE",
    });
  }
};
