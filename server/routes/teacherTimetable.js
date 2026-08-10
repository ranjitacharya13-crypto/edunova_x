const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const TeacherTimetable = require("../models/TeacherTimetable");

router.get("/today", async (req, res) => {
  try {
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({ error: "Teacher timetable is temporarily unavailable. Please try again shortly.", code: "DATABASE_UNAVAILABLE" });
    }
    const days = [
      "Sunday",
      "Monday",
      "Tuesday",
      "Wednesday",
      "Thursday",
      "Friday",
      "Saturday",
    ];

    const today = days[new Date().getDay()];
    const data = await TeacherTimetable.findOne({});

    if (!data || !data[today]) {
      return res.json({ day: today, timetable: [] });
    }

    res.json({
      day: today,
      timetable: data[today],
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch teacher timetable" });
  }
});

module.exports = router;
