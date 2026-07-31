const express = require("express");
const router = express.Router();
const TeacherTimetable = require("../models/TeacherTimetable");

router.get("/today", async (req, res) => {
  try {
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
    const data = await TeacherTimetable.findFirst();

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
