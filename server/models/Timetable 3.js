const mongoose = require("mongoose");

const daySchema = new mongoose.Schema({
  period: Number,
  // Optional: if not present in DB, the API can still derive it from the period number.
  time: String,
  subject: String,
});

const timetableSchema = new mongoose.Schema({
  Monday: [daySchema],
  Tuesday: [daySchema],
  Wednesday: [daySchema],
  Thursday: [daySchema],
  Friday: [daySchema],
});

module.exports = mongoose.model("Timetable", timetableSchema);
