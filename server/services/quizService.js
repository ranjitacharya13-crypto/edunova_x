// A quiz is an existing Assignment with kind=practice, not a fake PDF/file id.
const mongoose = require("mongoose");
const Assignment = require("../models/Assignment");
const QuizAttempt = require("../models/QuizAttempt");
const StudentProgress = require("../models/StudentProgress");
const { assignmentAccess, identity, requireDatabase, httpError } = require("./access");

function validateQuiz(input) {
  if (!input || typeof input !== "object") throw httpError("INVALID_QUIZ", "Quiz must be an object");
  const clean = (v, max) => typeof v === "string" && v.trim().length <= max ? v.trim() : "";
  const title = clean(input.title, 200), subject = clean(input.subject, 100);
  if (!title || !subject || !Array.isArray(input.questions) || input.questions.length < 1 || input.questions.length > 10) {
    throw httpError("INVALID_QUIZ", "Quiz needs a title, subject and 1–10 questions");
  }
  const seen = new Set();
  const questions = input.questions.map((q) => {
    if (!q || typeof q !== "object" || Array.isArray(q)) throw httpError("INVALID_QUIZ", "Question must be an object");
    const question = clean(q.question, 1000);
    const options = Array.isArray(q.options) ? q.options.map((o) => clean(o, 500)) : [];
    if (!question || seen.has(question.toLowerCase()) || options.length < 2 || options.length > 6 ||
        options.some((o) => !o) || new Set(options.map((o) => o.toLowerCase())).size !== options.length ||
        !Number.isInteger(q.answerIndex) || q.answerIndex < 0 || q.answerIndex >= options.length) {
      throw httpError("INVALID_QUIZ", "Questions must be unique with distinct options and a valid answer index");
    }
    seen.add(question.toLowerCase());
    return { question, options, answerIndex: q.answerIndex, explanation: clean(q.explanation || "", 1000) };
  });
  return { title, subject, questions };
}

async function createPracticeQuiz(user, args) {
  requireDatabase();
  const quiz = validateQuiz(args);
  if (args.arLessonId && !await require("../models/ARLesson").exists({ _id: args.arLessonId, published: true })) throw httpError("NOT_FOUND", "AR lesson not found", 404);
  const assignment = await Assignment.create({
    title: quiz.title, subject: quiz.subject, room: "personal-practice", kind: "practice",
    ownerId: identity(user), visibility: "private", fileId: null, filename: "",
    topic: String(args.topic || "").slice(0, 200), arLessonId: args.arLessonId || null,
    createdBy: { id: identity(user), name: user.name, role: user.role, email: user.email },
    quiz: quiz.questions,
  });
  return { success: true, quizId: String(assignment._id), title: quiz.title, totalQuestions: quiz.questions.length,
    navigate: { view: "quiz", id: String(assignment._id) }, message: `Quiz “${quiz.title}” saved to EduNova.` };
}

async function findQuiz(user, id) {
  requireDatabase();
  if (!mongoose.isValidObjectId(id)) throw httpError("INVALID_INPUT", "Invalid quiz id");
  const quiz = await Assignment.findOne({ $and: [{ _id: id }, assignmentAccess(user)] }).lean();
  if (!quiz || !quiz.quiz?.length) throw httpError("NOT_FOUND", "Quiz not found", 404);
  return quiz;
}
function publicQuiz(quiz) {
  return { id: String(quiz._id), title: quiz.title, subject: quiz.subject || quiz.room, topic: quiz.topic,
    questions: quiz.quiz.map(({ question, options }) => ({ question, options })) };
}
async function submitQuiz(user, id, answers) {
  const quiz = await findQuiz(user, id);
  if (!Array.isArray(answers) || answers.length !== quiz.quiz.length || answers.some((a, i) => !Number.isInteger(a) || a < 0 || a >= quiz.quiz[i].options.length)) {
    throw httpError("INVALID_INPUT", "Answer every question with a valid option");
  }
  const graded = quiz.quiz.map((q, i) => ({ question: q.question, selectedOption: q.options[answers[i]],
    correctOption: q.options[q.answerIndex], isCorrect: answers[i] === q.answerIndex, topic: quiz.topic || quiz.subject || quiz.room }));
  const correct = graded.filter((a) => a.isCorrect).length;
  const score = Math.round(correct / graded.length * 100);
  const attempt = await QuizAttempt.create({ userId: identity(user), assignmentId: quiz._id,
    quizTitle: quiz.title, subject: quiz.subject || quiz.room, topic: quiz.topic || "",
    score, correctAnswers: correct, totalQuestions: graded.length, answers: graded,
    weakTopics: [...new Set(graded.filter((a) => !a.isCorrect).map((a) => a.topic))] });
  // Progress is derived from scored attempts, not the LLM choosing percentages.
  // Read-time analysis also derives from QuizAttempt, so no dual-write data loss.
  return { success: true, attemptId: String(attempt._id), score, correctAnswers: correct,
    totalQuestions: graded.length, answers: graded };
}
async function performanceSummary(user) {
  requireDatabase();
  return QuizAttempt.aggregate([
    { $match: { userId: new mongoose.Types.ObjectId(String(identity(user))) } },
    { $group: { _id: "$subject", averageScore: { $avg: "$score" }, attempts: { $sum: 1 }, lastAttempt: { $max: "$createdAt" } } },
    { $sort: { averageScore: 1 } }, { $limit: 50 },
  ]);
}
module.exports = { validateQuiz, createPracticeQuiz, findQuiz, publicQuiz, submitQuiz, performanceSummary };
