const mongoose = require("mongoose");

const AttendanceSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    subject: { type: String, required: true },
    className: { type: String, default: "" },
    date: { type: Date, default: Date.now, index: true },
    status: { type: String, enum: ["present", "absent", "late"], default: "present" },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Attendance", AttendanceSchema);
