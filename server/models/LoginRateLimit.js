// server/models/LoginRateLimit.js
//
// Shared MongoDB store for login rate-limiting state across backend instances.
// Documents expire automatically via the TTL index on `expiresAt` so failed
// attempts never accumulate indefinitely.
const mongoose = require("mongoose");

const loginRateLimitSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true },
    failures: { type: [Number], default: [] },
    expiresAt: {
      type: Date,
      required: true,
      index: { expireAfterSeconds: 0 },
    },
  },
  { versionKey: false, timestamps: false }
);

module.exports =
  mongoose.models.LoginRateLimit ||
  mongoose.model("LoginRateLimit", loginRateLimitSchema);
