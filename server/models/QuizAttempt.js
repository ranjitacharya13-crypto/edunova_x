const mongoose = require("mongoose");

const QuizAttemptAnswerSchema = new mongoose.Schema(
  {
    question: { type: String, required: true },
    selectedOption: { type: String, required: true },
    correctOption: { type: String, required: true },
    isCorrect: { type: Boolean, required: true },
    topic: { type: String, default: "" },
  },
  { _id: false }
);

const QuizAttemptSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    assignmentId: { type: mongoose.Schema.Types.ObjectId, ref: "Assignment", default: null },
    quizTitle: { type: String, required: true },
    subject: { type: String, required: true, index: true },
    topic: { type: String, default: "" },
    score: { type: Number, required: true }, // percentage 0-100
    totalQuestions: { type: Number, required: true },
    correctAnswers: { type: Number, required: true },
    answers: { type: [QuizAttemptAnswerSchema], default: [] },
    weakTopics: { type: [String], default: [] },
    feedback: { type: String, default: "" },
  },
  { timestamps: true }
);

module.exports = mongoose.model("QuizAttempt", QuizAttemptSchema);
