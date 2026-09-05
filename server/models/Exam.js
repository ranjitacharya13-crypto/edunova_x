const mongoose = require("mongoose");

const ExamSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null, index: true },
    room: { type: String, default: "" },
    title: { type: String, required: true },
    subject: { type: String, required: true, index: true },
    date: { type: Date, required: true, index: true },
    durationMinutes: { type: Number, default: 90 },
    venue: { type: String, default: "Main Examination Hall" },
    syllabusTopics: { type: [String], default: [] },
    totalMarks: { type: Number, default: 100 },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Exam", ExamSchema);
