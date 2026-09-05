const mongoose = require("mongoose");

const StudySessionSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    subject: { type: String, required: true, index: true },
    topic: { type: String, required: true },
    durationMinutes: { type: Number, default: 30 },
    completed: { type: Boolean, default: false },
    notes: { type: String, default: "" },
    date: { type: Date, default: Date.now, index: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model("StudySession", StudySessionSchema);
