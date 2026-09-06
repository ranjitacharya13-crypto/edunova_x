const mongoose = require("mongoose");

const QuizQuestionSchema = new mongoose.Schema(
  {
    question: { type: String, required: true },
    options: { type: [String], required: true },
    answerIndex: { type: Number, required: true },
    explanation: { type: String, default: "" },
  },
  { _id: false }
);

const AssignmentSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: ["assignment", "practice"], default: "assignment" },
    ownerId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null, index: true },
    visibility: { type: String, enum: ["shared", "private"], default: "shared" },
    subject: { type: String, default: "" },
    topic: { type: String, default: "" },
    arLessonId: { type: mongoose.Schema.Types.ObjectId, ref: "ARLesson", default: null },
    completedBy: { type: [mongoose.Schema.Types.ObjectId], default: [] },
    room: { type: String, required: true, index: true },
    title: { type: String, required: true },
    fileId: { type: mongoose.Schema.Types.ObjectId, default: null },
    filename: { type: String, default: "" },
    createdBy: {
      id: { type: mongoose.Schema.Types.ObjectId, required: true },
      name: { type: String, required: true },
      role: { type: String, required: true },
      email: { type: String, required: true },
    },
    quiz: { type: [QuizQuestionSchema], default: [] },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Assignment", AssignmentSchema);

