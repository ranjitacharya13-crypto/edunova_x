const mongoose = require("mongoose");

const AiAuditLogSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true, index: true },
    conversationId: { type: String, default: "", index: true },
    toolName: { type: String, required: true, index: true },
    sourceType: {
      type: String,
      enum: ["database", "external", "utility", "model", "application"],
      required: true,
    },
    success: { type: Boolean, required: true },
    durationMs: { type: Number, default: 0 },
    error: { type: String, default: "" },
    timestamp: { type: Date, default: Date.now, index: true },
  },
  { versionKey: false }
);

module.exports = mongoose.model("AiAuditLog", AiAuditLogSchema);
