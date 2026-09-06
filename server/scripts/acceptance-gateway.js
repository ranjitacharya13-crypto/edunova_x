#!/usr/bin/env node
// Acceptance gateway: the REAL server/routes/ai.js Express router (JWT auth,
// rate limit, internal token, readiness gate, SSE relay) without MongoDB.
//
// Only two things are replaced, both clearly test fixtures:
//   1. the mongoose user lookup inside middleware/auth.js (echo the JWT id);
//   2. the database behind the application tools (a fixture timetable), so the
//      authenticated tool path  orchestrator -> ToolRegistry -> HTTP -> gateway
//      -> tool handler  is exercised end-to-end with a deterministic dataset.
// The AI answer itself always comes from the real model.
const express = require("express");
const mongoose = require("mongoose");

process.env.JWT_SECRET = process.env.JWT_SECRET || "acceptance-jwt-secret";
const FIXTURE_USER = { _id: "acceptance-student-000001", email: "student@edunova.test", role: "student", name: "Acceptance Student", timezone: "UTC" };
mongoose.Model.findById = (id) => ({ select: () => Promise.resolve({ ...FIXTURE_USER, _id: String(id) }) });

const tools = require("../services/applicationTools");
const today = new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: "UTC" }).format(new Date());
const FIXTURE = {
  get_timetable: { type: "student", schedule: { [today]: [{ period: 1, time: "09:00 - 09:45", subject: "Mathematics" }, { period: 2, time: "10:00 - 10:45", subject: "Physics" }] } },
  get_classes: { day: today, upcomingClasses: [{ period: 1, time: "09:00 - 09:45", subject: "Mathematics" }, { period: 2, time: "10:00 - 10:45", subject: "Physics" }], activeLiveSessions: [] },
  get_today_schedule: { day: today, periods: [{ period: 1, time: "09:00 - 09:45", subject: "Mathematics" }, { period: 2, time: "10:00 - 10:45", subject: "Physics" }], liveSessions: [] },
  get_upcoming_classes: { day: today, upcomingClasses: [{ period: 1, time: "09:00 - 09:45", subject: "Mathematics" }], activeLiveSessions: [] },
  get_subjects: { subjects: ["Mathematics", "Physics", "Chemistry"] },
  get_syllabus: { files: [] },
  get_learning_materials: { materials: [] },
  get_progress: { subjects: [{ subject: "Mathematics", progress: 72 }, { subject: "Physics", progress: 55 }] },
  get_study_history: { sessions: [] },
  get_quiz_results: { results: [] },
  get_assignments: { assignments: [] },
  get_attendance: { attendance: [] },
  get_student_profile: { name: FIXTURE_USER.name, role: "student" },
};
tools.executeApplicationTool = async (toolName, args, userId) => {
  if (!userId) return { success: false, status: 401, error: { code: "AUTH_FAILED", message: "Authenticated identity is required" } };
  if (!(toolName in FIXTURE)) return { success: false, status: 400, error: `Tool "${toolName}" is not registered in EduNova application registry.` };
  return { success: true, tool: toolName, sourceType: "database", data: FIXTURE[toolName], fixture: true };
};
// routes/ai.js destructures at require time, so patch before requiring it.
const aiRoutes = require("../routes/ai");

const app = express();
app.use(express.json({ limit: "1mb" }));
app.get("/health", (req, res) => res.json({ status: "ok", role: "acceptance-gateway" }));
app.use("/api/ai", aiRoutes);
const port = Number(process.env.PORT) || 4000;
app.listen(port, "127.0.0.1", () => console.log(`acceptance gateway listening on ${port} -> AI_ENGINE_URL=${process.env.AI_ENGINE_URL}`));
