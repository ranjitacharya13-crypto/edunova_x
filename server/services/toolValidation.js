const { httpError } = require("./access");
const { validateQuiz } = require("./quizService");
const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const READ_KEYS = {
  get_student_profile: [], get_subjects: [], get_timetable: ["day"], get_today_schedule: [], get_classes: [],
  get_upcoming_classes: [], get_syllabus: ["subject"], get_learning_materials: ["subject", "query"],
  get_progress: ["subject"], get_study_history: ["subject", "limit"], get_quiz_history: ["subject", "limit"],
  get_quiz_results: ["subject", "quizId"], get_assignments: ["room"], get_exams: ["subject"], get_attendance: [],
  get_notes: ["subject"], get_goals: [], get_upcoming_events: [], get_notifications: [],
  get_learning_documents: ["subject"], get_ar_lessons: ["subject", "topic"], get_ar_context: ["lessonId", "hotspotId"],
  open_feature: ["view", "id"],
};
const WRITE_KEYS = {
  create_timetable: ["schedule"], update_timetable: ["schedule"],
  create_study_session: ["subject", "topic", "durationMinutes", "notes"], mark_study_complete: ["sessionId"],
  create_quiz: ["title", "subject", "questions", "topic", "arLessonId"], save_quiz: ["title", "subject", "questions", "topic", "arLessonId"],
  mark_assignment_complete: ["assignmentId"], update_progress: ["subject", "progressPercent", "weakTopics", "strongTopics"],
  create_note: ["title", "content", "subject"], set_goal: ["title", "subject", "targetDate"],
  create_study_plan: ["title", "subject", "targetExamDate", "schedule"],
};
function invalid(message) { throw httpError("INVALID_TOOL_INPUT", message); }
function text(value, field, max = 200, required = false) {
  if (value === undefined && !required) return;
  if (typeof value !== "string" || value.length > max || (required && !value.trim())) invalid(`${field} is invalid`);
}
function validateToolArguments(tool, args) {
  if (!args || typeof args !== "object" || Array.isArray(args) || JSON.stringify(args).length > 24000) invalid("Tool arguments must be a bounded object");
  const keys = READ_KEYS[tool] || WRITE_KEYS[tool];
  if (!keys || Object.keys(args).some((key) => !keys.includes(key))) invalid("Unknown tool argument (identity and database operators are never accepted)");
  for (const [key, value] of Object.entries(args)) {
    if (!["questions", "schedule", "limit", "durationMinutes", "progressPercent", "weakTopics", "strongTopics"].includes(key)) text(value, key, key === "content" ? 5000 : key === "notes" ? 1000 : 200);
  }
  if (args.day && !DAYS.includes(args.day)) invalid("day must be a weekday name");
  for (const [key, min, max] of [["limit", 1, 30], ["durationMinutes", 5, 360], ["progressPercent", 0, 100]]) {
    if (args[key] !== undefined && (!Number.isInteger(args[key]) || args[key] < min || args[key] > max)) invalid(`${key} is out of range`);
  }
  for (const key of ["targetDate", "targetExamDate"]) if (args[key] && !Number.isFinite(Date.parse(args[key]))) invalid(`${key} must be a date`);
  if (["save_quiz", "create_quiz"].includes(tool)) validateQuiz(args);
  if (["create_timetable", "update_timetable"].includes(tool)) {
    if (!args.schedule || Array.isArray(args.schedule) || typeof args.schedule !== "object") invalid("schedule must be a weekday object");
    for (const [day, periods] of Object.entries(args.schedule)) {
      if (!DAYS.includes(day) || !Array.isArray(periods) || periods.length > 16) invalid("Invalid timetable schedule");
      for (const p of periods) {
        if (!p || Object.keys(p).some((k) => !["period", "time", "subject", "class"].includes(k)) || !Number.isInteger(p.period) || p.period < 1 || p.period > 16) invalid("Invalid timetable period");
        text(p.time, "time", 80, true);
        text(p.subject || p.class, "subject", 100, true);
      }
    }
  }
  if (tool === "create_study_plan") {
    text(args.title, "title", 200, true);
    if (!Array.isArray(args.schedule) || !args.schedule.length || args.schedule.length > 30) invalid("Study plan needs 1–30 sessions");
    for (const item of args.schedule) {
      if (!item || Object.keys(item).some((k) => !["day", "time", "subject", "topic", "task"].includes(k))) invalid("Invalid study plan session");
      for (const key of ["day", "subject", "topic", "task"]) text(item[key], key, 1000, true);
      text(item.time, "time", 100, true);
    }
  }
  if (tool === "create_study_session") { text(args.subject, "subject", 100, true); text(args.topic, "topic", 200, true); }
  if (tool === "create_note") { text(args.title, "title", 200, true); text(args.content, "content", 5000, true); }
  if (tool === "set_goal") text(args.title, "title", 200, true);
  return structuredClone(args);
}
module.exports = { validateToolArguments };
