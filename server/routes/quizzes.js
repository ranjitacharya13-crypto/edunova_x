const router = require("express").Router();
const auth = require("../middleware/auth");
const Assignment = require("../models/Assignment");
const StudyPlan = require("../models/StudyPlan");
const StudySession = require("../models/StudySession");
const { assignmentAccess, requireDatabase } = require("../services/access");
const { findQuiz, publicQuiz, submitQuiz, performanceSummary } = require("../services/quizService");
router.use(auth);
const handle = (fn) => async (req, res) => {
  try { requireDatabase(); res.json(await fn(req)); }
  catch (error) { res.status(error.status || 500).json({ success: false, error: { code: error.code || "DATABASE_FAILED", message: error.code ? error.message : "Quiz database operation failed" } }); }
};
router.get("/", handle(async (req) => ({ quizzes: await Assignment.find({ $and: [assignmentAccess(req.user), { "quiz.0": { $exists: true } }] }).select("title subject topic kind arLessonId createdAt").sort({ createdAt: -1 }).limit(60).lean() })));
router.get("/progress", handle(async (req) => ({ subjects: await performanceSummary(req.user),
  studyPlans: await StudyPlan.find({ userId: req.user.id }).sort({ createdAt: -1 }).limit(10).lean(),
  studyHistory: await StudySession.find({ userId: req.user.id }).sort({ date: -1 }).limit(20).lean() })));
router.get("/:id", handle(async (req) => ({ quiz: publicQuiz(await findQuiz(req.user, req.params.id)) })));
router.post("/:id/attempts", handle((req) => submitQuiz(req.user, req.params.id, req.body.answers)));
module.exports = router;
