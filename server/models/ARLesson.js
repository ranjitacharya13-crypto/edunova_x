const mongoose = require("mongoose");
const Hotspot = new mongoose.Schema({
  id: { type: String, required: true }, label: { type: String, required: true },
  position: { type: [Number], required: true }, normal: { type: [Number], default: [0, 1, 0] },
  description: { type: String, required: true }, aiContext: { type: String, default: "" },
  questionReference: { type: String, default: "" },
}, { _id: false });
const Lesson = new mongoose.Schema({
  slug: { type: String, required: true, unique: true },
  subjectId: { type: String, required: true, index: true }, subject: { type: String, required: true },
  syllabusTopicId: { type: String, default: "", index: true }, topic: { type: String, required: true },
  materialId: { type: mongoose.Schema.Types.ObjectId, default: null, index: true },
  title: { type: String, required: true }, description: { type: String, required: true },
  modelUrl: { type: String, required: true }, lowDetailModelUrl: { type: String, default: "" },
  fallbackImage: { type: String, default: "" }, assetBytes: { type: Number, max: 8388608, default: 0 },
  hotspots: { type: [Hotspot], default: [] }, learningObjectives: { type: [String], default: [] },
  quizId: { type: mongoose.Schema.Types.ObjectId, ref: "Assignment", default: null },
  published: { type: Boolean, default: true }, createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
}, { timestamps: true });
module.exports = mongoose.model("ARLesson", Lesson);
