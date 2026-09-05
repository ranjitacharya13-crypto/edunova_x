const mongoose = require("mongoose");

const PlanDayItemSchema = new mongoose.Schema(
  {
    day: { type: String, required: true },
    time: { type: String, default: "17:00 - 18:30" },
    subject: { type: String, required: true },
    topic: { type: String, required: true },
    task: { type: String, required: true },
    completed: { type: Boolean, default: false },
  },
  { _id: false }
);

const StudyPlanSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    title: { type: String, required: true },
    subject: { type: String, default: "" },
    targetExamDate: { type: Date, default: null },
    schedule: { type: [PlanDayItemSchema], default: [] },
    status: { type: String, enum: ["active", "completed", "archived"], default: "active" },
  },
  { timestamps: true }
);

module.exports = mongoose.model("StudyPlan", StudyPlanSchema);
