const mongoose = require("mongoose");

const QuizQuestionSchema = new mongoose.Schema(
  {
    question: { type: String, required: true },
    options: { type: [String], required: true },
    answerIndex: { type: Number, required: true },
  },
  { _id: false }
);

const AssignmentSchema = new mongoose.Schema(
  {
    room: { type: String, required: true, index: true },
    title: { type: String, required: true },
    fileId: { type: mongoose.Schema.Types.ObjectId, required: true },
    filename: { type: String, required: true },
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

