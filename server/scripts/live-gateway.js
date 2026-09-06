// Live end-to-end gateway used by the AI architecture manual/live checks.
//
// Boots the REAL Express /api/ai route module against a REAL FastAPI AI
// service (no scripted upstream). The only replaced piece is the MongoDB user
// lookup (there is no database in a bare sandbox); JWT authentication and the
// full warm-queue/SSE/retry pipeline run untouched.
//
// This file is a developer/test tool and is intentionally NOT mounted by
// server.js. Do not use it in production.
//
// Usage:
//   JWT_SECRET=live-secret node scripts/live-gateway.js http://127.0.0.1:8001 4090
//
// Listens on 0.0.0.0:PORT and serves POST /api/ai/chat (+ the other /api/ai
// routes) exactly like the deployed API service.

"use strict";

const http = require("node:http");
const express = require("express");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");

const aiRoutes = require("../routes/ai");

process.env.JWT_SECRET = process.env.JWT_SECRET || "live-gateway-dev-secret";

// Replace only the MongoDB user lookup with a fixed development identity so the
// auth middleware can complete without a database. Never used in production.
function stubUserLookup(id) {
  mongoose.Model.findById = (lookupId) => ({
    select: () =>
      Promise.resolve({
        _id: String(lookupId),
        email: "live@edunova.test",
        role: "student",
        name: "Live Test Student",
      }),
  });
}

function startGateway({ aiEngineUrl, port = 0 } = {}) {
  return new Promise((resolve, reject) => {
    if (!aiEngineUrl) {
      reject(new Error("aiEngineUrl is required (e.g. http://127.0.0.1:8001)"));
      return;
    }
    process.env.AI_ENGINE_URL = aiEngineUrl;
    stubUserLookup();
    const app = express();
    app.use(express.json({ limit: "1mb" }));
    app.use("/api/ai", aiRoutes);
    app.get("/__gateway", (req, res) => {
      res.json({ ok: true, upstream: process.env.AI_ENGINE_URL });
    });
    const server = http.createServer(app);
    server.on("error", reject);
    server.listen(port, "0.0.0.0", () => {
      const address = server.address();
      const signToken = (id) => jwt.sign({ id }, process.env.JWT_SECRET);
      resolve({ server, port: address.port, signToken, app });
    });
  });
}

module.exports = { startGateway };

// Direct CLI boot for manual testing.
if (require.main === module) {
  const aiUrl = process.argv[2] || "http://127.0.0.1:8001";
  const port = Number(process.argv[3] || 4090);
  startGateway({ aiEngineUrl: aiUrl, port })
    .then(({ server, port: bound }) => {
      console.log(`LIVE_GATEWAY_READY port=${bound} upstream=${process.env.AI_ENGINE_URL}`);
      console.log(`Chat SSE : POST http://127.0.0.1:${bound}/api/ai/chat`);
      const shutdown = () => server.close(() => process.exit(0));
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
    })
    .catch((err) => {
      console.error("gateway failed", err);
      process.exit(1);
    });
}
