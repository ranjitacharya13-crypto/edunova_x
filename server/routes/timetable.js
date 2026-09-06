const express = require("express");
const router = express.Router();
const Timetable = require("../models/Timetable");
const LiveSession = require("../models/LiveSession");
const Recording = require("../models/Recording");
const auth = require("../middleware/auth");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");

const PERIOD_TIMES = {
  1: "9:30 - 10:15",
  2: "10:15 - 11:00",
  3: "11:00 - 11:45",
  4: "11:45 - 12:30",
  5: "12:30 - 1:00",
  6: "1:30 - 2:15",
  7: "2:15 - 3:00",
  8: "3:00 - 3:45",
  9: "3:45 - 4:00",
};

function teacherOrStaffOrAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "Not authenticated" });
  if (!["admin", "teacher", "staff"].includes(req.user.role)) {
    return res.status(403).json({ error: "Teacher/staff/admin only" });
  }
  next();
}

function normalizeRoom(room) {
  return String(room || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function formatClock(d = new Date()) {
  try {
    return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(d);
  } catch {
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    return `${hh}:${mm}`;
  }
}

function getTodayRangeLocal(now = new Date()) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start, end };
}

const recordingsDir = path.join(__dirname, "..", "uploads", "live_recordings");
const recordingUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      try {
        fs.mkdirSync(recordingsDir, { recursive: true });
      } catch (e) {
        return cb(e);
      }
      return cb(null, recordingsDir);
    },
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname || "") || ".webm";
      const safeExt = /^\.[a-z0-9]+$/i.test(ext) ? ext : ".webm";
      const name = `${Date.now()}_${Math.random().toString(16).slice(2)}${safeExt}`;
      cb(null, name);
    },
  }),
  limits: { fileSize: 250 * 1024 * 1024 },
});

// GET today's timetable
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
    const timetableDoc = await Timetable.findOne({ ownerId: null, classId: null });

    if (!timetableDoc || !timetableDoc[today]) {
      return res.json({
        day: today,
        timetable: [],
        message: "No timetable for today",
      });
    }

    res.json({
      day: today,
      timetable: (timetableDoc[today] || []).map((p) => {
        const plain = typeof p?.toObject === "function" ? p.toObject() : p;
        const periodKey =
          plain?.period === undefined || plain?.period === null
            ? null
            : Number(plain.period);
        return {
          ...plain,
          time: plain?.time || (periodKey ? PERIOD_TIMES[periodKey] : "") || "",
        };
      }),
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to fetch timetable" });
  }
});

// ==========================
// LIVE SESSIONS (RECORDINGS)
// ==========================

// Start (or resume) a live session for today (teacher/staff/admin)
router.post("/live-sessions/start", auth, teacherOrStaffOrAdmin, async (req, res) => {
  try {
    const roomId = normalizeRoom(req.body.roomId || req.body.room);
    if (!roomId) return res.status(400).json({ error: "roomId is required" });

    const classNameRaw = String(req.body.className || "").trim();
    const className = classNameRaw || roomId;

    const now = new Date();
    const { start, end } = getTodayRangeLocal(now);

    const existing = await LiveSession.findOne({
      roomId,
      teacherId: req.user.id,
      date: { $gte: start, $lt: end },
    }).sort({ createdAt: -1 });

    if (existing && !existing.endTime) {
      return res.json({ session: existing });
    }

    const session = await LiveSession.create({
      roomId,
      teacherId: req.user.id,
      className,
      date: now,
      startTime: formatClock(now),
      endTime: "",
      recordingUrl: "",
      recordingPath: "",
      assignment: { title: "", description: "", fileUrl: "" },
    });

    return res.json({ session });
  } catch (e) {
    console.error("Live session start error", e);
    return res.status(500).json({ error: "Failed to start session" });
  }
});

// Attach/Update assignment on a live session (teacher/staff/admin)
router.post("/live-sessions/assignment", auth, teacherOrStaffOrAdmin, async (req, res) => {
  try {
    const sessionId = String(req.body.sessionId || "").trim();
    const roomId = normalizeRoom(req.body.roomId || req.body.room);
    const assignment = req.body.assignment || {};

    let session = null;
    if (sessionId) {
      session = await LiveSession.findById(sessionId);
    }

    if (!session) {
      if (!roomId) return res.status(400).json({ error: "roomId is required" });
      const now = new Date();
      const { start, end } = getTodayRangeLocal(now);
      session = await LiveSession.findOne({
        roomId,
        teacherId: req.user.id,
        date: { $gte: start, $lt: end },
      }).sort({ createdAt: -1 });
    }

    if (!session) return res.status(404).json({ error: "Session not found" });
    if (String(session.teacherId) !== String(req.user.id)) return res.status(403).json({ error: "Forbidden" });

    session.assignment = {
      title: String(assignment.title || "").trim(),
      description: String(assignment.description || "").trim(),
      fileUrl: String(assignment.fileUrl || "").trim(),
    };

    await session.save();
    return res.json({ session });
  } catch (e) {
    console.error("Live session assignment error", e);
    return res.status(500).json({ error: "Failed to attach assignment" });
  }
});

// End a live session + upload recording (teacher/staff/admin)
router.post(
  "/live-sessions/end",
  auth,
  teacherOrStaffOrAdmin,
  recordingUpload.single("recording"),
  async (req, res) => {
    try {
      const sessionId = String(req.body.sessionId || "").trim();
      if (!sessionId) return res.status(400).json({ error: "sessionId is required" });

      const session = await LiveSession.findById(sessionId);
      if (!session) return res.status(404).json({ error: "Session not found" });
      if (String(session.teacherId) !== String(req.user.id)) return res.status(403).json({ error: "Forbidden" });

      const now = new Date();
      session.endTime = formatClock(now);

      if (req.file?.path) {
        session.recordingPath = req.file.path;
        // Absolute URL so the static frontend (different origin) can play it.
        const origin = `${req.protocol}://${req.get("host")}`;
        session.recordingUrl = `${origin}/api/timetable/live-sessions/${session._id}/recording`;
      }

      await session.save();

      if (session.recordingUrl) {
        const durationRaw = Number(req.body.duration);
        const duration = Number.isFinite(durationRaw) && durationRaw > 0 ? durationRaw : 0;
        const timetableIdRaw = String(req.body.timetableId || "").trim();
        const timetableId = mongoose.Types.ObjectId.isValid(timetableIdRaw)
          ? new mongoose.Types.ObjectId(timetableIdRaw)
          : null;
        const titleRaw = String(req.body.title || "").trim();

        await Recording.findOneAndUpdate(
          { liveSessionId: session._id },
          {
            title: titleRaw || `${session.className} Recording`,
            room: session.roomId,
            teacherId: session.teacherId,
            timetableId,
            liveSessionId: session._id,
            videoUrl: session.recordingUrl,
            duration,
            createdAt: new Date(),
          },
          { upsert: true, new: true, setDefaultsOnInsert: true }
        );
      }

      return res.json({ session });
    } catch (e) {
      console.error("Live session end error", e);
      return res.status(500).json({ error: "Failed to end session" });
    }
  }
);

// List today's sessions (public; optionally filter by rooms)
router.get("/live-sessions/today", async (req, res) => {
  try {
    const { start, end } = getTodayRangeLocal(new Date());
    const roomsRaw = String(req.query.rooms || "").trim();
    const rooms = roomsRaw
      ? roomsRaw
          .split(",")
          .map((r) => normalizeRoom(r))
          .filter(Boolean)
      : [];

    const filter = { date: { $gte: start, $lt: end } };
    if (rooms.length) filter.roomId = { $in: rooms };

    const sessions = await LiveSession.find(filter).sort({ createdAt: 1 }).lean();
    const byRoom = {};
    for (const s of sessions) {
      if (!s?.roomId) continue;
      byRoom[s.roomId] = s;
    }

    return res.json({ sessions, byRoom });
  } catch (e) {
    console.error("Live sessions today error", e);
    return res.status(500).json({ error: "Failed to fetch sessions" });
  }
});

// Stream recording (public)
router.get("/live-sessions/:id/recording", async (req, res) => {
  try {
    const session = await LiveSession.findById(req.params.id).lean();
    if (!session) return res.status(404).json({ error: "Not found" });
    const recordingPath = String(session.recordingPath || "").trim();
    if (!recordingPath) return res.status(404).json({ error: "Recording not available" });

    const abs = path.resolve(recordingPath);
    if (!fs.existsSync(abs)) return res.status(404).json({ error: "Recording file missing" });

    res.setHeader("Content-Type", "video/webm");
    return res.sendFile(abs);
  } catch (e) {
    console.error("Recording stream error", e);
    return res.status(500).json({ error: "Failed to stream recording" });
  }
});

module.exports = router;
