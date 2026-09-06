const router = require("express").Router();
const auth = require("../middleware/auth");
const { listLessons, getLesson, saveLesson } = require("../services/arLessons");
router.use(auth);
const handle = (fn) => async (req, res) => {
  try { res.json(await fn(req)); }
  catch (error) { res.status(error.status || 500).json({ success: false, error: { code: error.code || "DATABASE_FAILED", message: error.code ? error.message : "AR lesson database operation failed" } }); }
};
router.get("/lessons", handle((req) => listLessons(req.user, { subject: String(req.query.subject || "").slice(0, 100), topic: String(req.query.topic || "").slice(0, 200) })));
router.get("/lessons/:id", handle(async (req) => ({ lesson: await getLesson(req.user, req.params.id) })));
router.post("/lessons", handle(async (req) => ({ lesson: await saveLesson(req.user, req.body) })));
module.exports = router;
