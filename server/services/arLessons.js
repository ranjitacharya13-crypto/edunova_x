const mongoose = require("mongoose");
const ARLesson = require("../models/ARLesson");
const { requireDatabase, httpError, escapeRegex } = require("./access");
const { findQuiz } = require("./quizService");

function validateLesson(input) {
  const keys = ["slug", "subjectId", "subject", "syllabusTopicId", "topic", "materialId", "title", "description", "modelUrl", "lowDetailModelUrl", "fallbackImage", "assetBytes", "hotspots", "learningObjectives", "quizId", "published"];
  if (!input || typeof input !== "object" || Object.keys(input).some((k) => !keys.includes(k))) throw httpError("INVALID_AR_LESSON", "Unknown lesson field");
  const data = structuredClone(input);
  for (const key of ["slug", "subjectId", "subject", "topic", "title", "description"]) {
    if (typeof data[key] !== "string" || !data[key].trim() || data[key].length > (key === "description" ? 4000 : 200)) throw httpError("INVALID_AR_LESSON", `Invalid ${key}`);
  }
  if (!/^[a-z0-9-]{1,100}$/.test(data.slug)) throw httpError("INVALID_AR_LESSON", "Invalid slug");
  for (const key of ["modelUrl", "lowDetailModelUrl", "fallbackImage"]) {
    if (data[key] && !/^\/ar-assets\/[a-zA-Z0-9_-]+\.(glb|gltf|png|jpg|svg)$/.test(data[key])) throw httpError("INVALID_AR_ASSET", "Use a reviewed same-origin /ar-assets/ asset");
  }
  if (!data.modelUrl || !/\.(glb|gltf)$/.test(data.modelUrl)) throw httpError("INVALID_AR_ASSET", "A GLB/glTF model is required");
  if (!Number.isInteger(data.assetBytes) || data.assetBytes < 1 || data.assetBytes > 8 * 1024 * 1024) throw httpError("INVALID_AR_ASSET", "Asset must be between 1 byte and 8 MiB");
  for (const key of ["quizId", "materialId"]) if (data[key] && !mongoose.isValidObjectId(data[key])) throw httpError("INVALID_AR_LESSON", `Invalid ${key}`);
  if (data.published !== undefined && typeof data.published !== "boolean") throw httpError("INVALID_AR_LESSON", "published must be boolean");
  if (!Array.isArray(data.hotspots) || data.hotspots.length > 24) throw httpError("INVALID_AR_LESSON", "At most 24 hotspots");
  const ids = new Set();
  for (const hotspot of data.hotspots) {
    if (!hotspot || Object.keys(hotspot).some((k) => !["id", "label", "position", "normal", "description", "aiContext", "questionReference"].includes(k))) throw httpError("INVALID_AR_LESSON", "Invalid hotspot");
    if (!/^[a-z0-9-]{1,60}$/.test(hotspot.id) || ids.has(hotspot.id)) throw httpError("INVALID_AR_LESSON", "Hotspot ids must be unique");
    ids.add(hotspot.id);
    for (const key of ["label", "description"]) if (typeof hotspot[key] !== "string" || !hotspot[key].trim() || hotspot[key].length > 2000) throw httpError("INVALID_AR_LESSON", `Invalid hotspot ${key}`);
    for (const key of ["aiContext", "questionReference"]) if (hotspot[key] !== undefined && (typeof hotspot[key] !== "string" || hotspot[key].length > 2000)) throw httpError("INVALID_AR_LESSON", `Invalid hotspot ${key}`);
    for (const key of ["position", "normal"]) if (hotspot[key] !== undefined && (!Array.isArray(hotspot[key]) || hotspot[key].length !== 3 || hotspot[key].some((n) => !Number.isFinite(n) || Math.abs(n) > 100))) throw httpError("INVALID_AR_LESSON", "Hotspot position must be 3 finite coordinates");
    if (!hotspot.position) throw httpError("INVALID_AR_LESSON", "Hotspot position is required");
  }
  if (!Array.isArray(data.learningObjectives) || data.learningObjectives.length < 1 || data.learningObjectives.length > 12 || data.learningObjectives.some((o) => typeof o !== "string" || !o.trim() || o.length > 500)) throw httpError("INVALID_AR_LESSON", "Provide 1–12 learning objectives");
  return data;
}
async function listLessons(user, args = {}) {
  requireDatabase();
  const filter = { published: true };
  if (args.subject) filter.subject = new RegExp(escapeRegex(args.subject), "i");
  if (args.topic) filter.topic = new RegExp(escapeRegex(args.topic), "i");
  if (args.materialId) filter.materialId = args.materialId;
  return { lessons: await ARLesson.find(filter).select("slug subjectId subject syllabusTopicId topic title description fallbackImage materialId").limit(60).lean() };
}
async function getLesson(user, id) {
  requireDatabase();
  if (!mongoose.isValidObjectId(id) && !/^[a-z0-9-]{1,100}$/.test(id)) throw httpError("INVALID_INPUT", "Invalid lesson id");
  const filter = mongoose.isValidObjectId(id) ? { _id: id } : { slug: id };
  const lesson = await ARLesson.findOne({ ...filter, published: true }).lean();
  if (!lesson) throw httpError("NOT_FOUND", "AR lesson not found", 404);
  return lesson;
}
async function educationalContext(user, args) {
  const lesson = await getLesson(user, args.lessonId);
  const hotspot = args.hotspotId ? lesson.hotspots.find((h) => h.id === args.hotspotId) : null;
  if (args.hotspotId && !hotspot) throw httpError("NOT_FOUND", "Hotspot not found", 404);
  return { lessonId: String(lesson._id), subject: lesson.subject, topic: lesson.topic, object: lesson.title,
    description: lesson.description, selectedPart: hotspot?.label || null,
    partDescription: hotspot?.description || null, educationalNotes: hotspot?.aiContext || "",
    learningObjectives: lesson.learningObjectives, quizId: lesson.quizId || null };
}
async function saveLesson(user, input) {
  requireDatabase();
  if (!["teacher", "admin"].includes(user.role)) throw httpError("PERMISSION_DENIED", "Teacher or admin only", 403);
  const data = validateLesson(input);
  if (data.quizId) await findQuiz(user, data.quizId);
  return ARLesson.create({ ...data, createdBy: user.id || user._id });
}
async function seedCurriculum() {
  const lessons = require("../catalog/ar-lessons.json");
  for (const raw of lessons) {
    const data = validateLesson(raw);
    await ARLesson.updateOne({ slug: data.slug }, { $setOnInsert: data }, { upsert: true, runValidators: true });
  }
}
module.exports = { validateLesson, listLessons, getLesson, educationalContext, saveLesson, seedCurriculum };
