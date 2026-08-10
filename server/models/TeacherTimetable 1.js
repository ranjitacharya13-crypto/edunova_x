const mongoose = require("mongoose");

const periodSchema = new mongoose.Schema({
  period: {
    type: Number,
    required: true,
  },
  time: {
    type: String,
    required: true,
  },
  class: {
    type: String,
    required: true,
  },
});

const teacherTimetableSchema = new mongoose.Schema(
  {
    Monday: [periodSchema],
    Tuesday: [periodSchema],
    Wednesday: [periodSchema],
    Thursday: [periodSchema],
    Friday: [periodSchema],
  },
  {
    collection: "teacher_timetables",
    timestamps: true,
  }
);

module.exports = mongoose.model(
  "TeacherTimetable",
  teacherTimetableSchema
);
