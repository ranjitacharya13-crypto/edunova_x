// Security and integration tests for authenticated EduNova application tools.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert");
const express = require("express");
const mongoose = require("mongoose");

const User = require("../models/User");
const Timetable = require("../models/Timetable");
const StudyPlan = require("../models/StudyPlan");
const AiAuditLog = require("../models/AiAuditLog");
const { executeApplicationTool, confirmApplicationTool, TOOL_HANDLERS } = require("../services/applicationTools");
const aiRoutes = require("../routes/ai");

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/ai", aiRoutes);
  return app;
}

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
  });
}

const original = {
  readyState: mongoose.connection.readyState,
  findUser: User.findById,
  findTimetable: Timetable.findOne,
  createPlan: StudyPlan.create,
  auditCreate: AiAuditLog.create,
  token: process.env.AI_INTERNAL_TOKEN,
};

function stubDatabase() {
  mongoose.connection.readyState = 1;
  User.findById = async (id) => ({
    _id: id,
    name: "Test Student",
    username: "test",
    email: "test@example.com",
    role: "student",
    grade: "10",
    subjects: ["Physics"],
    enrolledClasses: ["10A"],
    goals: [],
    notes: [],
    isBlocked: false,
  });
  Timetable.findOne = async () => ({ Monday: [{ period: 1, subject: "Physics" }] });
  StudyPlan.create = async (data) => ({ _id: new mongoose.Types.ObjectId(), ...data });
  AiAuditLog.create = async () => ({});
}

before(() => {
  process.env.AI_INTERNAL_TOKEN = "test-internal-token";
});

after(() => {
  mongoose.connection.readyState = original.readyState;
  User.findById = original.findUser;
  Timetable.findOne = original.findTimetable;
  StudyPlan.create = original.createPlan;
  AiAuditLog.create = original.auditCreate;
  if (original.token === undefined) delete process.env.AI_INTERNAL_TOKEN;
  else process.env.AI_INTERNAL_TOKEN = original.token;
});

describe("ApplicationToolRegistry & Internal Tool Execution", () => {
  test("registry contains required database and write tools", () => {
    for (const toolName of [
      "get_student_profile", "get_subjects", "get_timetable", "get_today_schedule",
      "get_syllabus", "get_learning_materials", "get_progress", "get_study_history",
      "get_quiz_history", "get_quiz_results", "get_assignments", "get_exams",
      "get_attendance", "create_timetable", "create_study_session", "create_quiz",
      "save_quiz", "update_progress", "create_note", "set_goal", "create_study_plan",
    ]) assert.ok(TOOL_HANDLERS[toolName], `Tool ${toolName} should be registered`);
  });

  test("reads real model data for the authenticated user", async () => {
    stubDatabase();
    const userId = new mongoose.Types.ObjectId().toString();
    const profile = await executeApplicationTool("get_student_profile", {}, userId);
    assert.strictEqual(profile.success, true);
    assert.deepStrictEqual(profile.data.subjects, ["Physics"]);
    const timetable = await executeApplicationTool("get_timetable", { day: "Monday" }, userId);
    assert.strictEqual(timetable.success, true);
    assert.strictEqual(timetable.data.schedule.Monday[0].subject, "Physics");
  });

  test("writes through the real StudyPlan model", async () => {
    stubDatabase();
    const userId = new mongoose.Types.ObjectId().toString();
    const result = await executeApplicationTool("create_study_plan", {
      title: "Physics plan",
      subject: "Physics",
      schedule: [{ day: "Monday", time: "17:00", topic: "Waves", task: "Practice", subject: "Physics" }],
    }, userId);
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.data.requiresConfirmation, true);
    assert.ok(result.data.confirmationToken);
    const confirmed = await confirmApplicationTool(result.data.confirmationToken, userId);
    assert.strictEqual(confirmed.success, true);
    assert.ok(confirmed.data.planId);
  });

  test("internal endpoint requires the shared service token", async () => {
    const server = await listen(makeApp());
    try {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/ai/internal/tools`, {
        method: "POST", headers: { "Content-Type": "application/json", "X-User-Id": new mongoose.Types.ObjectId().toString() },
        body: JSON.stringify({ tool: "get_student_profile", arguments: {} }),
      });
      assert.strictEqual(response.status, 401);
    } finally { server.close(); }
  });

  test("body userId cannot override the trusted identity header", async () => {
    stubDatabase();
    const trustedId = new mongoose.Types.ObjectId().toString();
    const forgedId = new mongoose.Types.ObjectId().toString();
    let lookedUpId = "";
    User.findById = async (id) => {
      lookedUpId = String(id);
      return { _id: id, name: "Owner", email: "owner@example.com", role: "student", subjects: [], enrolledClasses: [], goals: [], notes: [], isBlocked: false };
    };
    const server = await listen(makeApp());
    try {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/ai/internal/tools`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-AI-Internal-Token": "test-internal-token", "X-User-Id": trustedId },
        body: JSON.stringify({ tool: "get_student_profile", arguments: {}, userId: forgedId }),
      });
      assert.strictEqual(response.status, 200);
      assert.strictEqual(lookedUpId, trustedId);
      assert.notStrictEqual(lookedUpId, forgedId);
    } finally { server.close(); }
  });

  test("disconnected database returns an error instead of fabricated student data", async () => {
    mongoose.connection.readyState = 0;
    const result = await executeApplicationTool("get_quiz_results", { subject: "Physics" }, new mongoose.Types.ObjectId().toString());
    assert.strictEqual(result.success, false);
    assert.match(result.error, /database is unavailable/i);
  });
});
