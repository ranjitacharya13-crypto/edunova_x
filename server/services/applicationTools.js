// server/services/applicationTools.js
/**
 * ApplicationToolRegistry & Service Layer for EduNova Internal Application Data.
 *
 * Security Principles:
 * 1. Zero Trust: The AI model NEVER determines authorization.
 * 2. Authenticated user context is strictly injected by the backend (req.user / X-User-Id).
 * 3. All write operations pass through application validation before database storage.
 * 4. Audit logging records execution safely without secrets or tokens.
 */

const mongoose = require("mongoose");
const crypto = require("node:crypto");
const User = require("../models/User");
const Timetable = require("../models/Timetable");
const TeacherTimetable = require("../models/TeacherTimetable");
const LiveSession = require("../models/LiveSession");
const Assignment = require("../models/Assignment");
const Recording = require("../models/Recording");
const QuizAttempt = require("../models/QuizAttempt");
const StudySession = require("../models/StudySession");
const Exam = require("../models/Exam");
const Attendance = require("../models/Attendance");
const StudentProgress = require("../models/StudentProgress");
const StudyPlan = require("../models/StudyPlan");
const AiAuditLog = require("../models/AiAuditLog");
const ARLesson = require("../models/ARLesson");
const { assignmentAccess, roomsFor, identity, legacyShared, escapeRegex, httpError, materialAccess } = require("./access");
const { validateToolArguments } = require("./toolValidation");
const { createPracticeQuiz, performanceSummary } = require("./quizService");
const { learningDocuments } = require("./learningMaterials");
const { listLessons, educationalContext, getLesson } = require("./arLessons");

async function openFeature(user, args) {
  const allowed = ["home", "syllabus", "study", "live", "quiz", "progress", "study-plans", "ar", "timetable", "assignments"];
  if (!allowed.includes(args.view)) throw httpError("INVALID_INPUT", "Unknown application destination");
  if (args.id) {
    if (args.view === "ar") await getLesson(user, args.id);
    else if (["quiz", "assignments"].includes(args.view)) await require("./quizService").findQuiz(user, args.id);
    else throw httpError("INVALID_INPUT", "This destination does not accept an id");
  }
  return { navigate: { view: args.view, ...(args.id ? { id: args.id } : {}) }, message: `Open ${args.view}` };
}


async function scopedTimetable(user) {
  const model = user.role === "teacher" ? TeacherTimetable : Timetable;
  const own = await model.findOne({ ownerId: identity(user) });
  if (own) return { doc: own, scope: "user" };
  const enrolled = roomsFor(user);
  const classroom = enrolled.length ? await model.findOne({ ownerId: null, classId: { $in: enrolled } }) : null;
  if (classroom) return { doc: classroom, scope: "class" };
  return { doc: await model.findOne(legacyShared), scope: "shared-school" };
}


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

const DAYS_OF_WEEK = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function isDbConnected() {
  return mongoose.connection.readyState === 1;
}


const pendingActions = new Map();
const PENDING_ACTION_TTL_MS = 10 * 60 * 1000;

function preparePendingAction(toolName, args, userId, conversationId) {
  for (const [key, value] of pendingActions) if (value.expiresAt < Date.now()) pendingActions.delete(key);
  if (pendingActions.size >= 1000) throw httpError("CAPACITY_LIMIT", "Action confirmation capacity reached", 429);
  const token = crypto.randomBytes(24).toString("base64url");
  pendingActions.set(token, { toolName, args: structuredClone(args), userId: String(userId), conversationId, expiresAt: Date.now() + PENDING_ACTION_TTL_MS });
  return {
    success: true,
    sourceType: "application",
    source: toolName.replace(/^create_|^update_|^mark_|^save_|^set_/, ""),
    data: {
      pending: true,
      requiresConfirmation: true,
      confirmationToken: token,
      toolName,
      preview: ["create_quiz", "save_quiz"].includes(toolName) ? { ...args, questions: args.questions.map(({ question, options }) => ({ question, options })) } : args,
      message: `Confirm to apply ${toolName.replaceAll("_", " ")} to EduNova.`,
    },
  };
}

async function confirmApplicationTool(token, userId) {
  const pending = pendingActions.get(String(token || ""));
  if (!pending || pending.expiresAt < Date.now() || pending.userId !== String(userId)) {
    if (pending?.expiresAt < Date.now()) pendingActions.delete(String(token || ""));
    return { success: false, error: "Confirmation is invalid or expired." };
  }
  pendingActions.delete(String(token));
  return executeApplicationTool(pending.toolName, pending.args, userId, pending.conversationId, { confirmed: true });
}

// Safe audit logging helper
async function recordAuditLog({ userId, conversationId, toolName, sourceType, success, durationMs, error }) {
  try {
    if (isDbConnected()) {
      await AiAuditLog.create({
        userId: String(userId || "anonymous"),
        conversationId: String(conversationId || ""),
        toolName: String(toolName || "unknown"),
        sourceType: sourceType || "database",
        success: Boolean(success),
        durationMs: Number(durationMs) || 0,
        error: error ? String(error).slice(0, 300) : "",
        timestamp: new Date(),
      });
    }
  } catch (err) {
    console.warn("[AiAuditLog] Failed to record log:", err.message);
  }
}

// ---------------------------------------------------------------------------
// Internal Tool Handlers
// ---------------------------------------------------------------------------

async function getStudentProfile(user) {
  return {
    id: user._id,
    name: user.name || "Student",
    username: user.username,
    email: user.email,
    role: user.role || "student",
    grade: user.grade || null,
    subjects: user.subjects || [],
    enrolledClasses: user.enrolledClasses || [],
    goalsCount: (user.goals || []).length,
    notesCount: (user.notes || []).length,
  };
}

function isFreeSlotSubject(subject) {
  return /\b(free|revision|break|self[- ]?study)\b/i.test(String(subject || ""));
}

function parseEndMinutes(timeRange) {
  const raw = String(timeRange || "");
  const parts = raw.split("-");
  const target = (parts[1] || parts[0] || "").trim();
  const match = target.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i);
  if (!match) return null;
  let hours = Number(match[1]);
  const minutes = Number(match[2]);
  const meridiem = (match[3] || "").toUpperCase();
  if (meridiem === "PM" && hours < 12) hours += 12;
  else if (meridiem === "AM" && hours === 12) hours = 0;
  else if (!meridiem && hours >= 1 && hours <= 6) hours += 12; // afternoon school periods (1:30 - 4:00)
  return hours * 60 + minutes;
}

function currentMinutesInTimezone(timeZone = "UTC") {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone,
    }).formatToParts(new Date());
    const hh = Number(parts.find((p) => p.type === "hour")?.value || 0);
    const mm = Number(parts.find((p) => p.type === "minute")?.value || 0);
    return hh * 60 + mm;
  } catch {
    const now = new Date();
    return now.getUTCHours() * 60 + now.getUTCMinutes();
  }
}

function normalizePeriods(rawList = []) {
  return rawList.map((p) => {
    const plain = typeof p?.toObject === "function" ? p.toObject() : p;
    const periodKey = plain?.period ? Number(plain.period) : null;
    const explicitTime =
      plain?.time ||
      (plain?.startTime && plain?.endTime ? `${plain.startTime} - ${plain.endTime}` : plain?.startTime || "");
    return {
      period: plain?.period ?? null,
      time: explicitTime || (periodKey ? PERIOD_TIMES[periodKey] : "") || "",
      subject: plain?.subject || plain?.class || "Free Period",
      ...(plain?.teacher ? { teacher: plain.teacher } : {}),
      ...(plain?.room ? { room: plain.room } : {}),
    };
  });
}

function findNextSchoolDay(timetableDoc, todayName) {
  if (!timetableDoc) return null;
  const startIdx = DAYS_OF_WEEK.indexOf(todayName);
  if (startIdx < 0) return null;
  for (let offset = 1; offset <= 7; offset += 1) {
    const candidateDay = DAYS_OF_WEEK[(startIdx + offset) % 7];
    if (candidateDay === "Saturday" || candidateDay === "Sunday") continue;
    const candidatePeriods = normalizePeriods(timetableDoc[candidateDay] || []);
    if (candidatePeriods.length > 0) {
      return { day: candidateDay, periods: candidatePeriods };
    }
  }
  return null;
}

async function getSubjects(user) {
  const set = new Set(
    (Array.isArray(user.subjects) ? user.subjects : [])
      .map((s) => String(s || "").trim())
      .filter((s) => s && !isFreeSlotSubject(s))
  );

  if (!set.size && isDbConnected()) {
    const { doc: timetable } = await scopedTimetable(user);
    if (timetable) {
      for (const day of ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"]) {
        for (const item of timetable[day] || []) {
          const name = String(item?.subject || item?.class || "").trim();
          if (name && !isFreeSlotSubject(name)) set.add(name);
        }
      }
    }
  }

  if (isDbConnected() && mongoose.connection.db && user._id) {
    const [progressDoc, attemptedSubjects] = await Promise.all([
      StudentProgress.findOne({ userId: user._id }).lean().catch(() => null),
      QuizAttempt.distinct("subject", { userId: user._id }).catch(() => []),
    ]);
    for (const item of progressDoc?.subjects || []) {
      const name = String(item?.subject || "").trim();
      if (name && !isFreeSlotSubject(name)) set.add(name);
    }
    for (const name of attemptedSubjects || []) {
      const clean = String(name || "").trim();
      if (clean && !isFreeSlotSubject(clean)) set.add(clean);
    }
  }

  const subjects = Array.from(set);
  return {
    subjects,
    enrolledClasses: user.enrolledClasses || [],
    totalSubjects: subjects.length,
  };
}

async function getTimetable(user, args = {}) {
  const isTeacher = user.role === "teacher";
  let doc = null;
  if (isDbConnected()) {
    ({ doc } = await scopedTimetable(user));
  }

  const dayFilter = args.day ? String(args.day).trim() : null;
  const days = dayFilter ? [dayFilter] : ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];

  const schedule = {};
  const availableStudySlots = {};
  for (const d of days) {
    const normalized = normalizePeriods(doc?.[d] || []);
    schedule[d] = normalized.map((p) => ({
      period: p.period,
      time: p.time,
      subject: p.subject === "Free Period" ? "Free / Study Period" : p.subject,
      ...(p.teacher ? { teacher: p.teacher } : {}),
      ...(p.room ? { room: p.room } : {}),
    }));
    const inSchoolFree = schedule[d]
      .filter((p) => isFreeSlotSubject(p.subject))
      .map((p) => ({ time: p.time || `Period ${p.period}`, type: "in-school-revision" }));
    availableStudySlots[d] = [
      ...inSchoolFree,
      { time: "16:30 - 18:00", type: "evening-study-block-1" },
      { time: "19:30 - 21:00", type: "evening-study-block-2" },
    ];
  }

  return {
    type: isTeacher ? "teacher" : "student",
    scope: doc?.ownerId ? "user" : doc?.classId ? "class" : "shared-school",
    schedule,
    availableStudySlots,
    hasEntries: Object.values(schedule).some((list) => list.length > 0),
  };
}

async function getTodaySchedule(user) {
  const tz = user.timezone || "UTC";
  const today = new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: tz }).format(new Date());
  let timetableDoc = null;
  let liveSessions = [];

  if (isDbConnected()) {
    ({ doc: timetableDoc } = await scopedTimetable(user));

    if (mongoose.connection.db || typeof LiveSession.find === "function") {
      const startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);
      const endOfDay = new Date(startOfDay);
      endOfDay.setDate(endOfDay.getDate() + 1);

      try {
        const query = LiveSession.find({
          date: { $gte: startOfDay, $lt: endOfDay },
          ...(user.role === "teacher" ? { teacherId: identity(user) } : { roomId: { $in: roomsFor(user) } }),
        });
        if (mongoose.connection.db && query && typeof query.sort === "function") {
          liveSessions = await query.sort({ createdAt: 1 }).lean();
        }
      } catch {
        liveSessions = [];
      }
    }
  }

  const periods = normalizePeriods(timetableDoc?.[today] || []);
  const nowMins = currentMinutesInTimezone(tz);
  const upcomingPeriodsToday = periods.filter((p) => {
    const endMins = parseEndMinutes(p.time);
    return endMins === null || endMins >= nowMins;
  });
  const freePeriodsToday = periods
    .filter((p) => isFreeSlotSubject(p.subject))
    .map((p) => ({ period: p.period, time: p.time, label: p.subject }));
  const nextSchoolDay = findNextSchoolDay(timetableDoc, today);

  return {
    day: today,
    date: new Date().toISOString().slice(0, 10),
    isWeekend: today === "Sunday" || today === "Saturday",
    periods,
    upcomingPeriodsToday,
    freeStudySlotsToday: [
      ...freePeriodsToday,
      { period: null, time: "16:30 - 18:00", label: "Post-class revision block" },
      { period: null, time: "19:30 - 21:00", label: "Evening practice & exam prep" },
    ],
    nextSchoolDay,
    liveSessions: liveSessions.map((s) => ({
      roomId: s.roomId,
      className: s.className,
      startTime: s.startTime,
      endTime: s.endTime,
      isLive: !s.endTime,
      hasRecording: Boolean(s.recordingUrl),
    })),
    summary: periods.length
      ? `You have ${periods.length} scheduled periods today (${today}).`
      : nextSchoolDay
        ? `No classes scheduled for ${today}; your next scheduled classes are on ${nextSchoolDay.day} (${nextSchoolDay.periods.length} periods).`
        : `No scheduled classes found for today (${today}).`,
  };
}

async function getUpcomingClasses(user) {
  const scheduleRes = await getTodaySchedule(user);
  const upcoming = scheduleRes.upcomingPeriodsToday.length
    ? scheduleRes.upcomingPeriodsToday
    : scheduleRes.nextSchoolDay?.periods || [];

  return {
    day: scheduleRes.day,
    upcomingDay: scheduleRes.upcomingPeriodsToday.length
      ? scheduleRes.day
      : scheduleRes.nextSchoolDay?.day || scheduleRes.day,
    upcomingClasses: upcoming,
    todayClasses: scheduleRes.periods,
    nextSchoolDay: scheduleRes.nextSchoolDay,
    activeLiveSessions: scheduleRes.liveSessions,
  };
}

async function getSyllabus(user, args = {}) {
  let files = [];
  const curriculumTopics = [];
  const subjectFilter = args.subject ? String(args.subject).toLowerCase().trim() : "";

  if (isDbConnected() && mongoose.connection.db) {
    files = await mongoose.connection.db
      .collection("syllabus_files.files")
      .find(materialAccess(user))
      .sort({ uploadDate: -1 })
      .limit(100)
      .toArray();

    const [arLessons, exams] = await Promise.all([
      ARLesson.find({ published: true }).select("subject title topic summary").limit(30).lean().catch(() => []),
      Exam.find({ $or: [{ userId: user._id }, { userId: null, room: { $in: [...roomsFor(user), "", "general"] } }] })
        .select("subject title syllabusTopics")
        .limit(30)
        .lean()
        .catch(() => []),
    ]);

    for (const lesson of arLessons) {
      if (subjectFilter && !String(lesson.subject || "").toLowerCase().includes(subjectFilter) && !String(lesson.title || "").toLowerCase().includes(subjectFilter)) {
        continue;
      }
      curriculumTopics.push({
        subject: lesson.subject || "General Science",
        topic: lesson.topic || lesson.title,
        source: "curriculum-module",
      });
    }
    for (const exam of exams) {
      if (subjectFilter && !String(exam.subject || "").toLowerCase().includes(subjectFilter)) continue;
      for (const topic of exam.syllabusTopics || []) {
        curriculumTopics.push({
          subject: exam.subject,
          topic,
          source: `exam:${exam.title}`,
        });
      }
    }
  }

  let filtered = files.map((f) => ({
    id: f._id,
    filename: f.filename,
    contentType: f.contentType,
    uploadDate: f.uploadDate,
    sizeBytes: f.length,
    metadata: { subject: f.metadata?.subject || "", topic: f.metadata?.topic || "", textStatus: f.metadata?.textStatus || "not_indexed" },
  }));

  if (subjectFilter) {
    filtered = filtered.filter((f) =>
      f.filename.toLowerCase().includes(subjectFilter) ||
      (f.metadata?.subject && String(f.metadata.subject).toLowerCase().includes(subjectFilter))
    );
  }

  const subjectsSummary = await getSubjects(user);

  return {
    enrolledSubjects: subjectsSummary.subjects,
    uploadedSyllabusFiles: filtered.slice(0, 10),
    curriculumTopics: curriculumTopics.slice(0, 25),
    totalFiles: filtered.length,
  };
}

async function getLearningMaterials(user, args = {}) {
  let files = [];
  let recordings = [];
  if (isDbConnected() && mongoose.connection.db) {
    files = await mongoose.connection.db
      .collection("study_files.files")
      .find(materialAccess(user))
      .sort({ uploadDate: -1 })
      .limit(100)
      .toArray();

    recordings = await Recording.find({ room: { $in: roomsFor(user) } })
      .sort({ createdAt: -1 })
      .limit(5)
      .lean();
  }

  const query = (args.query || args.subject || "").toLowerCase().trim();
  let list = files.map((f) => ({
    id: f._id,
    filename: f.filename,
    contentType: f.contentType,
    uploadDate: f.uploadDate,
    sizeBytes: f.length,
    metadata: { subject: f.metadata?.subject || "", topic: f.metadata?.topic || "", textStatus: f.metadata?.textStatus || "not_indexed" },
  }));

  if (query) {
    list = list.filter((f) =>
      f.filename.toLowerCase().includes(query) ||
      (f.metadata?.subject && String(f.metadata.subject).toLowerCase().includes(query))
    );
  }

  return {
    materials: list.slice(0, 10),
    recentRecordings: recordings.map((r) => ({
      title: r.title,
      room: r.room,
      videoUrl: r.videoUrl,
      durationMinutes: Math.round((r.duration || 0) / 60),
    })),
    totalMaterials: list.length,
  };
}

async function getProgress(user, args = {}) {
  let progress = null;
  if (isDbConnected() && user._id) {
    progress = await StudentProgress.findOne({ userId: user._id });
  }

  const canAggregate = Boolean(mongoose.connection.db) || QuizAttempt.aggregate !== mongoose.Model.aggregate;
  const quizPerformance = canAggregate ? await performanceSummary(user) : [];
  const weakSubjects = quizPerformance
    .filter((row) => typeof row.averageScore === "number" && row.averageScore < 60)
    .map((row) => ({ subject: row._id, averageScore: Math.round(row.averageScore), attempts: row.attempts }));
  const strongSubjects = quizPerformance
    .filter((row) => typeof row.averageScore === "number" && row.averageScore >= 75)
    .map((row) => ({ subject: row._id, averageScore: Math.round(row.averageScore), attempts: row.attempts }));

  if (!progress) {
    return {
      hasProgress: quizPerformance.length > 0,
      overallProgressPercent: null,
      subjects: [],
      quizPerformance,
      weakSubjects,
      strongSubjects,
      revisionPriorities: weakSubjects.map((w) => `${w.subject} (average quiz score ${w.averageScore}%)`),
    };
  }

  const subjectFilter = args.subject ? String(args.subject).toLowerCase().trim() : null;
  const filteredSubjects = subjectFilter
    ? progress.subjects.filter((s) => s.subject.toLowerCase() === subjectFilter)
    : progress.subjects;

  const progressWeakTopics = filteredSubjects.flatMap((s) =>
    (s.weakTopics || []).map((t) => `${s.subject}: ${t}`)
  );

  return {
    quizPerformance,
    weakSubjects,
    strongSubjects,
    revisionPriorities: [
      ...progressWeakTopics,
      ...weakSubjects.map((w) => `${w.subject} (average quiz score ${w.averageScore}%)`),
    ].slice(0, 10),
    overallProgressPercent: progress.overallProgressPercent,
    studyStreakDays: progress.studyStreakDays,
    totalStudyMinutes: progress.totalStudyMinutes,
    subjects: filteredSubjects,
  };
}

async function getStudyHistory(user, args = {}) {
  let sessions = [];
  if (isDbConnected() && user._id) {
    const limit = Math.max(1, Math.min(Number(args.limit) || 10, 30));
    const filter = { userId: user._id };
    if (args.subject) filter.subject = new RegExp(escapeRegex(String(args.subject).trim()), "i");
    sessions = await StudySession.find(filter).sort({ date: -1, createdAt: -1 }).limit(limit).lean();
  }

  return {
    totalSessions: sessions.length,
    sessions: sessions.map((s) => ({
      id: s._id,
      subject: s.subject,
      topic: s.topic,
      durationMinutes: s.durationMinutes,
      completed: s.completed,
      notes: s.notes,
      date: s.date || s.createdAt,
    })),
  };
}

async function getQuizHistory(user, args = {}) {
  let attempts = [];
  if (isDbConnected() && user._id) {
    const limit = Math.max(1, Math.min(Number(args.limit) || 10, 30));
    const filter = { userId: user._id };
    if (args.subject) filter.subject = new RegExp(escapeRegex(String(args.subject).trim()), "i");
    attempts = await QuizAttempt.find(filter).sort({ createdAt: -1 }).limit(limit).lean();
  }

  const scores = attempts.map((q) => Number(q.score)).filter((n) => Number.isFinite(n));
  const averageScore = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null;
  const highestScore = scores.length ? Math.max(...scores) : null;
  const lowestScore = scores.length ? Math.min(...scores) : null;

  const bySubject = new Map();
  for (const q of attempts) {
    const subj = String(q.subject || "General");
    const entry = bySubject.get(subj) || { total: 0, count: 0 };
    entry.total += Number(q.score) || 0;
    entry.count += 1;
    bySubject.set(subj, entry);
  }
  const weakSubjects = [];
  const strongSubjects = [];
  for (const [subj, stats] of bySubject.entries()) {
    const avg = Math.round(stats.total / stats.count);
    if (avg < 60) weakSubjects.push({ subject: subj, averageScore: avg, attempts: stats.count });
    else if (avg >= 75) strongSubjects.push({ subject: subj, averageScore: avg, attempts: stats.count });
  }

  return {
    totalAttempts: attempts.length,
    averageScore,
    highestScore,
    lowestScore,
    weakSubjects,
    strongSubjects,
    quizzes: attempts.map((q) => ({
      id: q._id,
      quizTitle: q.quizTitle,
      subject: q.subject,
      topic: q.topic,
      score: q.score,
      totalQuestions: q.totalQuestions,
      correctAnswers: q.correctAnswers,
      weakTopics: q.weakTopics || [],
      date: q.createdAt,
    })),
  };
}

async function getQuizResults(user, args = {}) {
  let attempt = null;
  if (isDbConnected() && user._id) {
    const filter = { userId: user._id };
    if (args.quizId && mongoose.Types.ObjectId.isValid(args.quizId)) {
      filter._id = args.quizId;
    } else if (args.subject) {
      filter.subject = new RegExp(escapeRegex(String(args.subject).trim()), "i");
    }
    attempt = await QuizAttempt.findOne(filter).sort({ createdAt: -1 }).lean();
  }

  if (!attempt) {
    let availableQuizzes = [];
    if (isDbConnected() && mongoose.connection.db) {
      const quizDocs = await Assignment.find({
        $and: [assignmentAccess(user), { "quiz.0": { $exists: true } }],
      })
        .select("title subject room topic")
        .sort({ createdAt: -1 })
        .limit(5)
        .lean()
        .catch(() => []);
      availableQuizzes = quizDocs.map((q) => ({
        id: String(q._id),
        title: q.title,
        subject: q.subject || q.room || "General",
        topic: q.topic || "",
      }));
    }
    return {
      hasResults: false,
      quizTitle: null,
      subject: args.subject || null,
      weakTopics: [],
      strongTopics: [],
      answersSummary: [],
      availablePracticeQuizzes: availableQuizzes,
      message: "No completed quiz attempts were found for this student account yet.",
    };
  }

  const answersSummary = (attempt.answers || []).map((a) => ({
    question: a.question,
    selectedOption: a.selectedOption,
    correctOption: a.correctOption,
    isCorrect: a.isCorrect,
    topic: a.topic || attempt.topic || attempt.subject || "",
  }));

  const missedQuestions = answersSummary.filter((a) => !a.isCorrect);
  const weakSet = new Set(
    [
      ...(attempt.weakTopics || []),
      ...missedQuestions.map((m) => m.topic),
    ]
      .map((t) => String(t || "").trim())
      .filter(Boolean)
  );
  const strongSet = new Set(
    answersSummary
      .filter((a) => a.isCorrect)
      .map((a) => String(a.topic || "").trim())
      .filter((t) => t && !weakSet.has(t))
  );
  if (!strongSet.size && Number(attempt.score) >= 75 && attempt.subject && !weakSet.has(attempt.subject)) {
    strongSet.add(attempt.subject);
  }

  const weakTopics = Array.from(weakSet);
  const strongTopics = Array.from(strongSet);
  const improvementRecommendations = [];
  if (weakTopics.length) {
    improvementRecommendations.push(`Review core concepts and worked examples in: ${weakTopics.join(", ")}.`);
  }
  if (missedQuestions.length) {
    improvementRecommendations.push(
      `Re-attempt the ${missedQuestions.length} missed question(s) from "${attempt.quizTitle}" and compare your selected answer with the correct option.`
    );
  }
  if (Number(attempt.score) >= 80) {
    improvementRecommendations.push(
      `Strong mastery (${attempt.score}%) — progress to timed mixed-topic practice in ${attempt.subject}.`
    );
  } else {
    improvementRecommendations.push(
      `Schedule a 30-minute focused revision session on ${attempt.subject}${attempt.topic ? ` (${attempt.topic})` : ""} before taking another practice quiz.`
    );
  }

  return {
    hasResults: true,
    quizTitle: attempt.quizTitle,
    subject: attempt.subject,
    topic: attempt.topic,
    scorePercentage: attempt.score,
    totalQuestions: attempt.totalQuestions,
    correctAnswers: attempt.correctAnswers,
    weakTopics,
    strongTopics,
    missedQuestions: missedQuestions.slice(0, 10),
    improvementRecommendations,
    feedback: attempt.feedback || "",
    answersSummary,
    attemptDate: attempt.createdAt,
  };
}

async function getAssignments(user, args = {}) {
  let assignments = [];
  if (isDbConnected()) {
    const filter = assignmentAccess(user);
    if (args.room) filter.room = String(args.room).toLowerCase().trim();
    assignments = await Assignment.find(filter).sort({ createdAt: -1 }).limit(10).lean();
  }

  return {
    total: assignments.length,
    assignments: assignments.map((a) => ({
      id: a._id,
      room: a.room,
      subject: a.subject || a.room || "",
      title: a.title,
      filename: a.filename,
      hasQuiz: Boolean(a.quiz && a.quiz.length > 0),
      quizQuestionCount: (a.quiz || []).length,
      createdAt: a.createdAt || null,
    })),
  };
}

async function getExams(user, args = {}) {
  let exams = [];
  if (isDbConnected()) {
    const filter = { $or: [{ userId: user._id }, { userId: null, room: { $in: [...roomsFor(user), "", "general"] } }] };
    if (args.subject) filter.subject = new RegExp(escapeRegex(String(args.subject).trim()), "i");
    exams = await Exam.find(filter).sort({ date: 1 }).limit(50).lean();
  }

  const now = Date.now();
  const mapped = exams.map((e) => {
    const examMs = e.date ? new Date(e.date).getTime() : null;
    const daysUntilExam = examMs && Number.isFinite(examMs)
      ? Math.ceil((examMs - now) / (24 * 60 * 60 * 1000))
      : null;
    return {
      id: e._id,
      title: e.title,
      subject: e.subject,
      date: e.date,
      daysUntilExam,
      venue: e.venue,
      syllabusTopics: e.syllabusTopics || [],
      durationMinutes: e.durationMinutes,
      totalMarks: e.totalMarks,
    };
  });

  return {
    totalExams: mapped.length,
    upcomingExams: mapped.filter((e) => e.daysUntilExam === null || e.daysUntilExam >= 0),
    exams: mapped,
  };
}

async function getAttendance(user) {
  let records = [];
  if (isDbConnected() && user._id) {
    records = await Attendance.find({ userId: user._id }).sort({ date: -1 }).limit(30).lean();
  }

  const total = records.length;
  const presentCount = records.filter((r) => r.status === "present").length;
  const attendanceRate = total ? Math.round((presentCount / total) * 100) : null;

  return {
    attendanceRatePercent: attendanceRate,
    totalClassesRecorded: total,
    presentCount,
    recentRecords: records.slice(0, 10).map((r) => ({
      subject: r.subject,
      date: r.date,
      status: r.status,
    })),
  };
}

async function getNotes(user, args = {}) {
  const subjectFilter = args.subject ? String(args.subject).toLowerCase().trim() : null;
  let notes = user.notes || [];
  if (subjectFilter) {
    notes = notes.filter((n) => (n.subject || "").toLowerCase().includes(subjectFilter));
  }
  return {
    totalNotes: notes.length,
    notes: notes.map((n) => ({
      id: n._id,
      title: n.title,
      content: n.content,
      subject: n.subject,
      createdAt: n.createdAt || null,
    })),
  };
}

async function getGoals(user) {
  return {
    goals: (user.goals || []).map((g) => ({
      id: g._id,
      title: g.title,
      subject: g.subject,
      targetDate: g.targetDate,
      completed: g.completed,
    })),
  };
}

async function getUpcomingEvents(user) {
  const exams = await getExams(user);
  return {
    events: exams.exams.map((e) => ({
      type: "exam",
      title: `${e.title} (${e.subject})`,
      date: e.date,
      details: `Venue: ${e.venue}`,
    })),
  };
}

async function getNotifications(user) {
  return { notifications: [], available: false };
}

// ---------------------------------------------------------------------------
// Internal Write Handlers
// ---------------------------------------------------------------------------

async function createTimetable(user, args = {}) {
  if (!["admin", "teacher"].includes(user.role)) throw httpError("PERMISSION_DENIED", "Only teachers or admins can change timetables", 403);
  const model = user.role === "teacher" ? TeacherTimetable : Timetable;
  const filter = user.role === "admin" ? legacyShared : { ownerId: user._id };
  const schedule = Object.fromEntries(Object.entries(args.schedule).map(([day, periods]) => [day, periods.map((p) => ({ period: p.period, time: p.time, [user.role === "teacher" ? "class" : "subject"]: p.class || p.subject }))]));
  const doc = await model.findOneAndUpdate(filter, { $set: schedule }, { upsert: true, new: true, runValidators: true });
  return { success: true, timetableId: doc._id, navigate: { view: "timetable" }, message: "Timetable updated successfully." };
}

async function updateTimetable(user, args = {}) {
  return createTimetable(user, args);
}

async function createStudySession(user, args = {}) {
  const subject = String(args.subject || "").trim();
  const topic = String(args.topic || "").trim();
  if (!subject || !topic) {
    throw new Error("subject and topic are required to create a study session");
  }

  const durationMinutes = Math.max(5, Math.min(Number(args.durationMinutes) || 30, 360));
  let sessionId;

  if (isDbConnected() && user._id) {
    const session = await StudySession.create({
      userId: user._id,
      subject,
      topic,
      durationMinutes,
      completed: Boolean(args.completed),
      notes: String(args.notes || "").slice(0, 1000),
      date: new Date(),
    });
    sessionId = session._id;
  }

  return {
    success: true,
    sessionId,
    subject,
    topic,
    durationMinutes,
    message: `Study session for ${subject}: "${topic}" logged successfully.`,
  };
}

async function markStudyComplete(user, args = {}) {
  if (!mongoose.isValidObjectId(args.sessionId)) throw httpError("INVALID_INPUT", "Invalid sessionId");
  const session = await StudySession.findOneAndUpdate({ _id: args.sessionId, userId: user._id }, { $set: { completed: true } }, { new: true });
  if (!session) throw httpError("NOT_FOUND", "Study session not found", 404);
  return { success: true, sessionId: String(session._id), message: "Study session marked as completed." };
}

async function createQuiz(user, args = {}) {
  return createPracticeQuiz(user, args);
}

async function saveQuiz(user, args = {}) {
  return createQuiz(user, args);
}

async function markAssignmentComplete(user, args = {}) {
  if (!mongoose.isValidObjectId(args.assignmentId)) throw httpError("INVALID_INPUT", "Invalid assignmentId");
  const doc = await Assignment.findOneAndUpdate({ $and: [{ _id: args.assignmentId }, assignmentAccess(user)] }, { $addToSet: { completedBy: user._id } }, { new: true });
  if (!doc) throw httpError("NOT_FOUND", "Assignment not found", 404);
  return { success: true, assignmentId: String(doc._id), message: "Assignment marked as completed." };
}

async function updateProgress() {
  throw httpError("PERMISSION_DENIED", "Progress is calculated from quiz attempts and completed study sessions, not AI-assigned scores", 403);
}

async function createNote(user, args = {}) {
  const title = String(args.title || "").trim();
  const content = String(args.content || "").trim();
  const subject = String(args.subject || "").trim();

  if (!title || !content) {
    throw new Error("title and content are required to create a note");
  }

  if (user.notes) {
    user.notes.push({ title, content, subject, createdAt: new Date() });
    if (typeof user.save === "function") await user.save();
  }

  return {
    success: true,
    noteTitle: title,
    subject,
    message: `Note "${title}" saved successfully.`,
  };
}

async function setGoal(user, args = {}) {
  const title = String(args.title || "").trim();
  if (!title) throw new Error("title is required for goal");

  const subject = String(args.subject || "").trim();
  const targetDate = args.targetDate ? new Date(args.targetDate) : null;

  if (user.goals) {
    user.goals.push({ title, subject, targetDate, completed: false });
    if (typeof user.save === "function") await user.save();
  }

  return {
    success: true,
    goalTitle: title,
    targetDate,
    message: `Goal "${title}" set successfully.`,
  };
}

async function createStudyPlan(user, args = {}) {
  const title = String(args.title || "").trim() || "Exam Preparation Plan";
  const subject = String(args.subject || "").trim();
  const targetExamDate = args.targetExamDate ? new Date(args.targetExamDate) : null;
  const schedule = Array.isArray(args.schedule) ? args.schedule : [];

  if (!schedule.length) {
    throw new Error("schedule items are required for creating a study plan");
  }

  let planId;
  if (isDbConnected() && user._id) {
    const plan = await StudyPlan.create({
      userId: user._id,
      title,
      subject,
      targetExamDate,
      schedule: schedule.map((item) => ({
        day: item.day,
        time: item.time,
        subject: item.subject,
        topic: item.topic,
        task: item.task,
        completed: false,
      })),
      status: "active",
    });
    planId = plan._id;
  }

  return {
    success: true,
    planId,
    title,
    totalSessions: schedule.length,
    navigate: { view: "progress" },
    message: `Study plan "${title}" created with ${schedule.length} sessions.`,
  };
}

// ---------------------------------------------------------------------------
// Tool Registry Dispatcher
// ---------------------------------------------------------------------------

const TOOL_HANDLERS = {
  get_ar_lessons: { handler: listLessons, sourceType: "database", isWrite: false },
  get_ar_context: { handler: educationalContext, sourceType: "database", isWrite: false },
  open_feature: { handler: openFeature, sourceType: "application", isWrite: false },
  // Read Tools
  get_learning_documents: { handler: learningDocuments, sourceType: "database", isWrite: false },
  get_classes: { handler: getUpcomingClasses, sourceType: "database", isWrite: false },
  get_student_profile: { handler: getStudentProfile, sourceType: "database", isWrite: false },
  get_subjects: { handler: getSubjects, sourceType: "database", isWrite: false },
  get_timetable: { handler: getTimetable, sourceType: "database", isWrite: false },
  get_today_schedule: { handler: getTodaySchedule, sourceType: "database", isWrite: false },
  get_upcoming_classes: { handler: getUpcomingClasses, sourceType: "database", isWrite: false },
  get_syllabus: { handler: getSyllabus, sourceType: "database", isWrite: false },
  get_learning_materials: { handler: getLearningMaterials, sourceType: "database", isWrite: false },
  get_progress: { handler: getProgress, sourceType: "database", isWrite: false },
  get_study_history: { handler: getStudyHistory, sourceType: "database", isWrite: false },
  get_quiz_history: { handler: getQuizHistory, sourceType: "database", isWrite: false },
  get_quiz_results: { handler: getQuizResults, sourceType: "database", isWrite: false },
  get_assignments: { handler: getAssignments, sourceType: "database", isWrite: false },
  get_exams: { handler: getExams, sourceType: "database", isWrite: false },
  get_attendance: { handler: getAttendance, sourceType: "database", isWrite: false },
  get_notes: { handler: getNotes, sourceType: "database", isWrite: false },
  get_goals: { handler: getGoals, sourceType: "database", isWrite: false },
  get_upcoming_events: { handler: getUpcomingEvents, sourceType: "database", isWrite: false },
  get_notifications: { handler: getNotifications, sourceType: "database", isWrite: false },

  // Write Tools
  create_timetable: { handler: createTimetable, sourceType: "application", isWrite: true },
  update_timetable: { handler: updateTimetable, sourceType: "application", isWrite: true },
  create_study_session: { handler: createStudySession, sourceType: "application", isWrite: true },
  mark_study_complete: { handler: markStudyComplete, sourceType: "application", isWrite: true },
  create_quiz: { handler: createQuiz, sourceType: "application", isWrite: true },
  save_quiz: { handler: saveQuiz, sourceType: "application", isWrite: true },
  mark_assignment_complete: { handler: markAssignmentComplete, sourceType: "application", isWrite: true },
  update_progress: { handler: updateProgress, sourceType: "application", isWrite: true },
  create_note: { handler: createNote, sourceType: "application", isWrite: true },
  set_goal: { handler: setGoal, sourceType: "application", isWrite: true },
  create_study_plan: { handler: createStudyPlan, sourceType: "application", isWrite: true },
};

async function executeApplicationTool(toolName, rawArgs = {}, userId, conversationId = "", options = {}) {
  const started = Date.now();
  const toolEntry = TOOL_HANDLERS[toolName];

  if (!toolEntry) {
    await recordAuditLog({
      userId,
      conversationId,
      toolName,
      sourceType: "database",
      success: false,
      durationMs: Date.now() - started,
      error: `Unknown tool: ${toolName}`,
    });
    return {
      success: false,
      error: `Tool "${toolName}" is not registered in EduNova application registry.`,
    };
  }

  let user;
  try {
    if (!isDbConnected()) throw httpError("DATABASE_FAILED", "EduNova database is unavailable", 503);
    if (!userId || !mongoose.Types.ObjectId.isValid(userId)) throw httpError("AUTH_FAILED", "Authenticated user identity is invalid", 401);
    user = await User.findById(userId);
    if (!user || user.isBlocked) throw httpError("AUTH_FAILED", "Authenticated user was not found or is blocked", 401);
    rawArgs = validateToolArguments(toolName, rawArgs);
    if (["create_timetable", "update_timetable"].includes(toolName) && !["teacher", "admin"].includes(user.role)) throw httpError("PERMISSION_DENIED", "Only teachers or admins can change timetables", 403);
    if (toolName === "update_progress") throw httpError("PERMISSION_DENIED", "Progress is derived from scored attempts, not assigned by AI", 403);
    if (toolEntry.isWrite && !options.confirmed) return preparePendingAction(toolName, rawArgs, userId, conversationId);
    const result = await toolEntry.handler(user, rawArgs);
    const durationMs = Date.now() - started;

    await recordAuditLog({
      userId: String(user._id),
      conversationId,
      toolName,
      sourceType: toolEntry.sourceType,
      success: true,
      durationMs,
    });

    return {
      success: true,
      sourceType: toolEntry.sourceType,
      source: toolName.replace(/^get_|^create_|^update_|^mark_|^save_|^set_/, ""),
      data: result,
      durationMs,
    };
  } catch (err) {
    const durationMs = Date.now() - started;
    await recordAuditLog({
      userId: String(user?._id || userId),
      conversationId,
      toolName,
      sourceType: toolEntry.sourceType,
      success: false,
      durationMs,
      error: err.code || err.name,
    });

    return {
      success: false,
      code: err.code || "DATABASE_FAILED",
      status: err.status || 500,
      error: err.code ? err.message : "EduNova database operation failed",
      durationMs,
    };
  }
}

module.exports = {
  executeApplicationTool,
  TOOL_HANDLERS,
  recordAuditLog,
  confirmApplicationTool,
  scopedTimetable,
};
