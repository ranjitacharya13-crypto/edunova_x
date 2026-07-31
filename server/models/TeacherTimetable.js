// server/models/TeacherTimetable.js
// SQL data-access layer for the `teacher_timetables` table
// (replaces the Mongoose model; same grid shape as the student timetable).
module.exports = require("./timetableStore")("teacher_timetables");
