const express = require("express");
const auth = require("../middleware/auth");
const User = require("../models/User");
const Timetable = require("../models/Timetable");
const TeacherTimetable = require("../models/TeacherTimetable");
const LiveSession = require("../models/LiveSession");
const Assignment = require("../models/Assignment");
const Recording = require("../models/Recording");
const ContactMessage = require("../models/ContactMessage");

const router = express.Router();

function adminOnly(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "Not authenticated" });
  if (req.user.role !== "admin") return res.status(403).json({ error: "Admin only" });
  return next();
}

router.use(auth, adminOnly);

function asDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function makeWeekBuckets(weeks = 8) {
  const now = new Date();
  const buckets = [];
  for (let i = weeks - 1; i >= 0; i -= 1) {
    const start = new Date(now);
    start.setDate(now.getDate() - now.getDay() - i * 7);
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(start.getDate() + 7);
    buckets.push({
      key: `${start.toISOString().slice(0, 10)}`,
      label: `${start.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`,
      start,
      end,
      count: 0,
    });
  }
  return buckets;
}

function bucketize(items, getDate) {
  const buckets = makeWeekBuckets(8);
  for (const item of items) {
    const d = asDate(getDate(item));
    if (!d) continue;
    const bucket = buckets.find((b) => d >= b.start && d < b.end);
    if (bucket) bucket.count += 1;
  }
  return buckets.map((b) => ({ label: b.label, count: b.count }));
}

async function getOverview() {
  const [totalUsers, totalStudents, totalTeachers, totalStudentTimetableDocs, totalTeacherTimetableDocs] =
    await Promise.all([
      User.countDocuments(),
      User.countDocuments({ role: "student" }),
      User.countDocuments({ role: "teacher" }),
      Timetable.countDocuments(),
      TeacherTimetable.countDocuments(),
    ]);

  const [totalLiveClasses, totalRecordedVideos, totalAssignments, totalMessages] = await Promise.all([
    LiveSession.countDocuments(),
    Recording.countDocuments(),
    Assignment.countDocuments(),
    ContactMessage.countDocuments(),
  ]);

  const [recentUsers, recentLive, recentAssignments, recentMessages] = await Promise.all([
    User.find({}, { name: 1, role: 1, createdAt: 1 }).sort({ createdAt: -1 }).limit(4).lean(),
    LiveSession.find({}, { className: 1, roomId: 1, createdAt: 1 }).sort({ createdAt: -1 }).limit(4).lean(),
    Assignment.find({}, { title: 1, room: 1, createdAt: 1 }).sort({ createdAt: -1 }).limit(4).lean(),
    ContactMessage.find({}, { name: 1, email: 1, createdAt: 1 }).sort({ createdAt: -1 }).limit(4).lean(),
  ]);

  const recentActivity = [
    ...recentUsers.map((u) => ({
      type: "user",
      title: `${u.name || "User"} (${u.role || "unknown"})`,
      createdAt:
        u.createdAt || (u._id && typeof u._id.getTimestamp === "function" ? u._id.getTimestamp() : null),
    })),
    ...recentLive.map((c) => ({
      type: "live_class",
      title: c.className || c.roomId || "Live class",
      createdAt: c.createdAt || null,
    })),
    ...recentAssignments.map((a) => ({
      type: "assignment",
      title: a.title || a.room || "Assignment",
      createdAt: a.createdAt || null,
    })),
    ...recentMessages.map((m) => ({
      type: "message",
      title: `${m.name || "Unknown"} (${m.email || "no-email"})`,
      createdAt: m.createdAt || null,
    })),
  ]
    .sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime())
    .slice(0, 12);

  return {
    totalUsers,
    totalStudents,
    totalTeachers,
    totalTimetables: totalStudentTimetableDocs + totalTeacherTimetableDocs,
    totalLiveClasses,
    totalRecordedVideos,
    totalAssignments,
    totalMessages,
    recentActivity,
  };
}

router.get("/dashboard", async (req, res) => {
  try {
    return res.json(await getOverview());
  } catch (error) {
    console.error("Admin dashboard error:", error);
    return res.status(500).json({ error: "Failed to load admin dashboard" });
  }
});

router.get("/users", async (req, res) => {
  try {
    const role = String(req.query.role || "").trim();
    const filter = role ? { role } : {};
    const users = await User.find(filter, { name: 1, email: 1, role: 1, createdAt: 1, isBlocked: 1 })
      .sort({ createdAt: -1, name: 1 })
      .lean();
    return res.json({
      users: users.map((u) => ({
        ...u,
        createdAt: u.createdAt || (u._id && typeof u._id.getTimestamp === "function" ? u._id.getTimestamp() : null),
      })),
    });
  } catch (error) {
    console.error("Admin users error:", error);
    return res.status(500).json({ error: "Failed to load users" });
  }
});

router.patch("/users/:id/block", async (req, res) => {
  try {
    const target = await User.findById(req.params.id);
    if (!target) return res.status(404).json({ error: "User not found" });

    const blockFlag =
      typeof req.body?.blocked === "boolean" ? req.body.blocked : !Boolean(target.isBlocked);
    target.isBlocked = blockFlag;
    await target.save();

    return res.json({
      user: {
        _id: target._id,
        name: target.name,
        email: target.email,
        role: target.role,
        isBlocked: target.isBlocked,
        createdAt: target.createdAt || null,
      },
    });
  } catch (error) {
    console.error("Admin block user error:", error);
    return res.status(500).json({ error: "Failed to update user status" });
  }
});

router.delete("/users/:id", async (req, res) => {
  try {
    if (String(req.params.id) === String(req.user.id)) {
      return res.status(403).json({ error: "Admin cannot delete self" });
    }

    const target = await User.findById(req.params.id);
    if (!target) return res.status(404).json({ error: "User not found" });
    if (target.role === "admin") return res.status(403).json({ error: "Cannot delete admin user" });

    await User.deleteOne({ _id: target._id });
    return res.json({ success: true });
  } catch (error) {
    console.error("Admin delete user error:", error);
    return res.status(500).json({ error: "Failed to delete user" });
  }
});

router.get("/timetables", async (req, res) => {
  try {
    const teacherFilter = String(req.query.teacher || "").trim().toLowerCase();
    const [studentDocs, teacherDocs] = await Promise.all([
      Timetable.find({}).lean(),
      TeacherTimetable.find({}).lean(),
    ]);

    const studentTimetables = studentDocs.map((doc) => ({
      _id: doc._id,
      type: "student",
      createdAt: doc.createdAt || null,
      data: doc,
    }));

    let teacherTimetables = teacherDocs.map((doc) => ({
      _id: doc._id,
      type: "teacher",
      createdAt: doc.createdAt || null,
      data: doc,
    }));

    if (teacherFilter) {
      teacherTimetables = teacherTimetables.filter((doc) => {
        const days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
        return days.some((day) =>
          (doc.data?.[day] || []).some((entry) =>
            String(entry?.class || "")
              .toLowerCase()
              .includes(teacherFilter)
          )
        );
      });
    }

    return res.json({
      timetables: [...teacherTimetables, ...studentTimetables],
    });
  } catch (error) {
    console.error("Admin timetables error:", error);
    return res.status(500).json({ error: "Failed to load timetables" });
  }
});

router.delete("/timetables/:type/:id", async (req, res) => {
  try {
    const type = String(req.params.type || "").trim().toLowerCase();
    const model = type === "teacher" ? TeacherTimetable : type === "student" ? Timetable : null;
    if (!model) return res.status(400).json({ error: "Invalid timetable type" });

    const result = await model.deleteOne({ _id: req.params.id });
    if (!result.deletedCount) return res.status(404).json({ error: "Timetable not found" });
    return res.json({ success: true });
  } catch (error) {
    console.error("Admin delete timetable error:", error);
    return res.status(500).json({ error: "Failed to delete timetable" });
  }
});

router.get("/liveclasses", async (req, res) => {
  try {
    const sessions = await LiveSession.find({})
      .sort({ createdAt: -1 })
      .populate("teacherId", "name email")
      .lean();

    return res.json({
      liveClasses: sessions.map((s) => ({
        _id: s._id,
        roomName: s.roomId,
        teacher: s.teacherId
          ? { id: s.teacherId._id, name: s.teacherId.name, email: s.teacherId.email }
          : null,
        participantsCount: 0,
        date: s.date || s.createdAt || null,
        status: s.endTime ? "ended" : "live",
      })),
    });
  } catch (error) {
    console.error("Admin live classes error:", error);
    return res.status(500).json({ error: "Failed to load live classes" });
  }
});

router.get("/videos", async (req, res) => {
  try {
    const videos = await Recording.find({})
      .sort({ createdAt: -1 })
      .populate("teacherId", "name email")
      .lean();

    return res.json({
      videos: videos.map((v) => ({
        _id: v._id,
        title: v.title,
        room: v.room,
        timetableId: v.timetableId || null,
        teacher: v.teacherId
          ? { id: v.teacherId._id, name: v.teacherId.name, email: v.teacherId.email }
          : null,
        videoUrl: v.videoUrl,
        duration: v.duration || 0,
        createdAt: v.createdAt || null,
      })),
    });
  } catch (error) {
    console.error("Admin videos error:", error);
    return res.status(500).json({ error: "Failed to load videos" });
  }
});

router.delete("/videos/:id", async (req, res) => {
  try {
    const result = await Recording.deleteOne({ _id: req.params.id });
    if (!result.deletedCount) return res.status(404).json({ error: "Video not found" });
    return res.json({ success: true });
  } catch (error) {
    console.error("Admin delete video error:", error);
    return res.status(500).json({ error: "Failed to delete video" });
  }
});

router.get("/assignments", async (req, res) => {
  try {
    const assignments = await Assignment.find({})
      .sort({ createdAt: -1 })
      .lean();

    return res.json({
      assignments: assignments.map((a) => ({
        _id: a._id,
        className: a.room,
        teacher: a.createdBy?.name || "Unknown",
        submissionCount: 0,
        dueDate: null,
        title: a.title,
        createdAt: a.createdAt || null,
      })),
    });
  } catch (error) {
    console.error("Admin assignments error:", error);
    return res.status(500).json({ error: "Failed to load assignments" });
  }
});

router.get("/messages", async (req, res) => {
  try {
    const messages = await ContactMessage.find({})
      .sort({ createdAt: -1 })
      .lean();
    return res.json({ messages });
  } catch (error) {
    console.error("Admin messages error:", error);
    return res.status(500).json({ error: "Failed to load messages" });
  }
});

router.delete("/messages/:id", async (req, res) => {
  try {
    const result = await ContactMessage.deleteOne({ _id: req.params.id });
    if (!result.deletedCount) return res.status(404).json({ error: "Message not found" });
    return res.json({ success: true });
  } catch (error) {
    console.error("Admin delete message error:", error);
    return res.status(500).json({ error: "Failed to delete message" });
  }
});

router.get("/analytics", async (req, res) => {
  try {
    const [users, teachers, liveClasses] = await Promise.all([
      User.find({}, { createdAt: 1 }).lean(),
      User.find({ role: "teacher" }, { createdAt: 1 }).lean(),
      LiveSession.find({}, { createdAt: 1 }).lean(),
    ]);

    const userGrowth = bucketize(users, (u) => u.createdAt || (u._id ? u._id.getTimestamp?.() : null));
    const teacherGrowth = bucketize(teachers, (u) => u.createdAt || (u._id ? u._id.getTimestamp?.() : null));
    const classesPerWeek = bucketize(liveClasses, (c) => c.createdAt || (c._id ? c._id.getTimestamp?.() : null));
    const activeUsers = userGrowth.map((d, idx) => ({
      label: d.label,
      count: d.count + (teacherGrowth[idx]?.count || 0),
    }));

    return res.json({ userGrowth, teacherGrowth, classesPerWeek, activeUsers });
  } catch (error) {
    console.error("Admin analytics error:", error);
    return res.status(500).json({ error: "Failed to load analytics" });
  }
});

module.exports = router;
