// Integration and unit tests for ApplicationToolRegistry and internal AI tools
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const express = require("express");
const mongoose = require("mongoose");

const { executeApplicationTool, TOOL_HANDLERS } = require("../services/applicationTools");
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

describe("ApplicationToolRegistry & Internal Tool Execution", () => {
  test("TOOL_HANDLERS contains all required database and write tools", () => {
    const expectedTools = [
      "get_student_profile",
      "get_subjects",
      "get_timetable",
      "get_today_schedule",
      "get_upcoming_classes",
      "get_syllabus",
      "get_learning_materials",
      "get_progress",
      "get_study_history",
      "get_quiz_history",
      "get_quiz_results",
      "get_assignments",
      "get_exams",
      "get_attendance",
      "get_notes",
      "get_goals",
      "get_upcoming_events",
      "get_notifications",
      "create_timetable",
      "update_timetable",
      "create_study_session",
      "mark_study_complete",
      "create_quiz",
      "save_quiz",
      "mark_assignment_complete",
      "update_progress",
      "create_note",
      "set_goal",
      "create_study_plan",
    ];

    for (const toolName of expectedTools) {
      assert.ok(TOOL_HANDLERS[toolName], `Tool ${toolName} should be registered`);
    }
  });

  test("executeApplicationTool successfully retrieves student schedule and profile", async () => {
    const profileRes = await executeApplicationTool("get_student_profile", {}, "test-student-123");
    assert.strictEqual(profileRes.success, true);
    assert.strictEqual(profileRes.sourceType, "database");
    assert.ok(profileRes.data.subjects.length > 0);

    const scheduleRes = await executeApplicationTool("get_today_schedule", {}, "test-student-123");
    assert.strictEqual(scheduleRes.success, true);
    assert.strictEqual(scheduleRes.sourceType, "database");
    assert.ok(scheduleRes.data.day);
  });

  test("executeApplicationTool executes write action create_study_plan safely", async () => {
    const planArgs = {
      title: "Midterm Review Plan",
      subject: "Physics",
      schedule: [
        { day: "Monday", time: "18:00 - 19:30", topic: "Thermodynamics", task: "Review Carnot engine" },
        { day: "Tuesday", time: "18:00 - 19:30", topic: "Kinematics", task: "Solve projectile motion equations" },
      ],
    };

    const planRes = await executeApplicationTool("create_study_plan", planArgs, "test-student-123");
    assert.strictEqual(planRes.success, true);
    assert.strictEqual(planRes.sourceType, "application");
    assert.ok(planRes.data.totalSessions >= 2);
  });

  test("HTTP POST /api/ai/internal/tools executes tool and returns structured result", async () => {
    const app = await listen(makeApp());
    const address = app.address();
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/ai/internal/tools`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-User-Id": "student-test-456",
        },
        body: JSON.stringify({
          tool: "get_quiz_results",
          arguments: { subject: "Physics" },
          conversationId: "conv-123",
        }),
      });

      assert.strictEqual(response.status, 200);
      const json = await response.json();
      assert.strictEqual(json.success, true);
      assert.strictEqual(json.sourceType, "database");
    } finally {
      app.close();
    }
  });

  test("HTTP POST /api/ai/internal/tools rejects unknown tool gracefully", async () => {
    const app = await listen(makeApp());
    const address = app.address();
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/ai/internal/tools`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tool: "non_existent_tool", arguments: {} }),
      });

      assert.strictEqual(response.status, 200);
      const json = await response.json();
      assert.strictEqual(json.success, false);
      assert.match(json.error, /not registered/i);
    } finally {
      app.close();
    }
  });
});
