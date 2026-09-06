const mongoose = require("mongoose");

const daySchema = new mongoose.Schema({
  period: Number,
  // Optional: if not present in DB, the API can still derive it from the period number.
  time: String,
  subject: String,
});

const timetableSchema = new mongoose.Schema({
    ownerId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null, index: true },
    classId: { type: String, default: null, index: true },
  Monday: [daySchema],
  Tuesday: [daySchema],
  Wednesday: [daySchema],
  Thursday: [daySchema],
  Friday: [daySchema],
});

module.exports = mongoose.model("Timetable", timetableSchema);
