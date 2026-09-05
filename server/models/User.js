const mongoose = require("mongoose");

const GoalSchema = new mongoose.Schema(
  {
    title: { type: String, required: true },
    targetDate: { type: Date, default: null },
    completed: { type: Boolean, default: false },
    subject: { type: String, default: "" },
  },
  { _id: true, timestamps: true }
);

const NoteSchema = new mongoose.Schema(
  {
    title: { type: String, required: true },
    content: { type: String, required: true },
    subject: { type: String, default: "" },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: true }
);

const userSchema = new mongoose.Schema(
  {
    name: String,
    dob: String,
    gender: String,
    username: { type: String, unique: true },
    email: { type: String, unique: true, required: true },
    password: { type: String, required: true },
    role: { type: String, enum: ["admin", "teacher", "student"], default: "student" },
    isBlocked: { type: Boolean, default: false },
    grade: { type: String, default: "Standard Grade" },
    subjects: { type: [String], default: ["Physics", "Mathematics", "Chemistry", "Computer Science"] },
    enrolledClasses: { type: [String], default: ["General"] },
    goals: { type: [GoalSchema], default: [] },
    notes: { type: [NoteSchema], default: [] },
  },
  { timestamps: true }
);

// Export the model
module.exports = mongoose.model("User", userSchema);
