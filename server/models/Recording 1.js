const mongoose = require("mongoose");

const recordingSchema = new mongoose.Schema(
  {
    title: { type: String, required: true },
    room: { type: String, required: true, index: true },
    teacherId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true, ref: "User" },
    timetableId: { type: mongoose.Schema.Types.ObjectId, default: null },
    liveSessionId: { type: mongoose.Schema.Types.ObjectId, index: true, ref: "LiveSession" },
    videoUrl: { type: String, required: true },
    duration: { type: Number, default: 0 },
    createdAt: { type: Date, default: Date.now },
  },
  { versionKey: false }
);

module.exports = mongoose.model("Recording", recordingSchema);
