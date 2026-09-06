const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth");
const { scopedTimetable } = require("../services/applicationTools");
const optionalAuth = (req, res, next) => req.headers.authorization ? auth(req, res, next) : next();
const TeacherTimetable = require("../models/TeacherTimetable");

router.get("/today", optionalAuth, async (req, res) => {
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

    const today = new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: req.user?.timezone || "UTC" }).format(new Date());
    const data = req.user && ["teacher", "admin"].includes(req.user.role) ? (await scopedTimetable({ ...req.user, role: "teacher" })).doc : await TeacherTimetable.findOne({ ownerId: null, classId: null });

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
