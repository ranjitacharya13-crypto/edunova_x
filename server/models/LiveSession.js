const mongoose = require("mongoose");

const LiveSessionSchema = new mongoose.Schema(
  {
    roomId: { type: String, required: true, index: true },
    teacherId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    className: { type: String, required: true },
    date: { type: Date, required: true, index: true },
    startTime: { type: String, required: true },
    endTime: { type: String, default: "" },
    recordingUrl: { type: String, default: "" },
    recordingPath: { type: String, default: "" },
    assignment: {
      title: { type: String, default: "" },
      description: { type: String, default: "" },
      fileUrl: { type: String, default: "" },
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("LiveSession", LiveSessionSchema);

