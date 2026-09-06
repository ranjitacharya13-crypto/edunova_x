const mongoose = require("mongoose");

const SubjectProgressSchema = new mongoose.Schema(
  {
    subject: { type: String, required: true },
    overallProgressPercent: { type: Number, default: 0 },
    completedModules: { type: Number, default: 0 },
    totalModules: { type: Number, default: 0 },
    weakTopics: { type: [String], default: [] },
    strongTopics: { type: [String], default: [] },
    recentAverageScore: { type: Number, default: 0 },
    lastStudiedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const StudentProgressSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, unique: true, index: true },
    overallProgressPercent: { type: Number, default: 0 },
    subjects: { type: [SubjectProgressSchema], default: [] },
    studyStreakDays: { type: Number, default: 0 },
    totalStudyMinutes: { type: Number, default: 0 },
  },
  { timestamps: true }
);

module.exports = mongoose.model("StudentProgress", StudentProgressSchema);
