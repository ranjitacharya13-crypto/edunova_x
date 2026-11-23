// Master integration suite for EduNova AI status normalization, direct & upstream
// orchestration, student-data grounding, verified research, and user isolation.
// Asserts response content across Scenarios 1–12.

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const express = require("express");
const axios = require("axios");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

process.env.JWT_SECRET = process.env.JWT_SECRET || "ai-master-fix-test-secret";
process.env.AI_UPSTREAM_RETRY_DELAYS_MS = "5,10";
process.env.AI_UPSTREAM_RETRY_WINDOW_MS = "500";
process.env.AI_RATE_LIMIT_MAX_REQUESTS = "200";

const User = require("../models/User");
const Timetable = require("../models/Timetable");
const StudentProgress = require("../models/StudentProgress");
const QuizAttempt = require("../models/QuizAttempt");
const Assignment = require("../models/Assignment");
const Exam = require("../models/Exam");
const StudyPlan = require("../models/StudyPlan");
const StudySession = require("../models/StudySession");
const Recording = require("../models/Recording");
const ARLesson = require("../models/ARLesson");
const LiveSession = require("../models/LiveSession");
const AiAuditLog = require("../models/AiAuditLog");
const aiRoutes = require("../routes/ai");

const ALICE_ID = new mongoose.Types.ObjectId().toString();
const BOB_ID = new mongoose.Types.ObjectId().toString();
const NEW_STUDENT_ID = new mongoose.Types.ObjectId().toString();
const OPTICS_QUIZ_ID = new mongoose.Types.ObjectId();
const HISTORY_QUIZ_ID = new mongoose.Types.ObjectId();

const USERS = {
  [ALICE_ID]: {
    _id: ALICE_ID,
    name: "Alice Sharma",
    username: "alice",
    email: "alice@edunova.test",
    role: "student",
    grade: "10",
    subjects: ["Mathematics", "Physics", "Biology"],
    enrolledClasses: ["10A"],
    goals: [{ title: "Score above 85% in Physics Midterm", targetDate: "2026-12-01", progress: 40 }],
    notes: [],
    isBlocked: false,
  },
  [BOB_ID]: {
    _id: BOB_ID,
    name: "Bob Verma",
    username: "bob",
    email: "bob@edunova.test",
    role: "student",
    grade: "11",
    subjects: ["World History", "Literature"],
    enrolledClasses: ["11B"],
    goals: [{ title: "Finish Industrial Revolution essay", targetDate: "2026-12-05", progress: 90 }],
    notes: [],
    isBlocked: false,
  },
  [NEW_STUDENT_ID]: {
    _id: NEW_STUDENT_ID,
    name: "Neha Rao",
    username: "neha",
    email: "neha@edunova.test",
    role: "student",
    grade: "9",
    subjects: [],
    enrolledClasses: [],
    goals: [],
    notes: [],
    isBlocked: false,
  },
};

function makeChain(result) {
  const chain = {
    select: () => chain,
    sort: () => chain,
    limit: () => chain,
    lean: () => Promise.resolve(result),
    then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
  };
  return chain;
}

function matchesOwner(filter, ownerId) {
  const serialized = JSON.stringify(filter || {});
  return serialized.includes(String(ownerId));
}

const savedEnv = { ...process.env };
const savedModels = {
  readyState: mongoose.connection.readyState,
  db: mongoose.connection.db,
  userFindById: User.findById,
  timetableFindOne: Timetable.findOne,
  progressFindOne: StudentProgress.findOne,
  attemptFind: QuizAttempt.find,
  attemptFindOne: QuizAttempt.findOne,
  attemptAggregate: QuizAttempt.aggregate,
  attemptDistinct: QuizAttempt.distinct,
  assignmentFind: Assignment.find,
  assignmentDistinct: Assignment.distinct,
  examFind: Exam.find,
  planFind: StudyPlan.find,
  sessionFind: StudySession.find,
  recordingFind: Recording.find,
  lessonFind: ARLesson.find,
  liveFind: LiveSession.find,
  auditCreate: AiAuditLog.create,
  axiosGet: axios.get,
};

let researchShouldReturnEmpty = false;

function installMockDatabase() {
  mongoose.connection.readyState = 1;
  mongoose.connection.db = {
    databaseName: "edunova_test",
    collection: (name) => ({
      find: (filter = {}) => ({
        sort: () => ({
          limit: () => ({
            toArray: async () => {
              if (name === "syllabus_files.files" && matchesOwner(filter, ALICE_ID)) {
                return [
                  {
                    _id: new mongoose.Types.ObjectId(),
                    filename: "Class_10_Physics_Optics_Syllabus.pdf",
                    contentType: "application/pdf",
                    length: 2048,
                    metadata: {
                      subject: "Physics",
                      topic: "Refraction & Lenses",
                      extractedText:
                        "Unit 4 Optics: Snell's Law n1 sin(theta1) = n2 sin(theta2), critical angle, total internal reflection, thin lens formula.",
                      textStatus: "indexed",
                    },
                  },
                ];
              }
              return [];
            },
          }),
        }),
      }),
      updateOne: async () => ({}),
    }),
  };

  User.findById = (id) => {
    const user = USERS[String(id)] || null;
    const res = Promise.resolve(user);
    res.select = () => Promise.resolve(user);
    return res;
  };

  Timetable.findOne = (filter = {}) => {
    if (matchesOwner(filter, ALICE_ID) || JSON.stringify(filter).includes("10A")) {
      const doc = {
        className: "10A",
        Monday: [
          { period: 1, subject: "Mathematics", startTime: "09:00", endTime: "10:00", teacher: "Dr. Raman", room: "204" },
          { period: 2, subject: "Physics", startTime: "10:15", endTime: "11:15", teacher: "Prof. Nair", room: "Lab 3" },
        ],
        Tuesday: [
          { period: 1, subject: "Biology", startTime: "09:00", endTime: "10:00", teacher: "Dr. Meera", room: "Bio 1" },
        ],
        Wednesday: [],
        Thursday: [],
        Friday: [],
        Saturday: [],
        Sunday: [],
      };
      return makeChain({ ...doc, toObject: () => doc });
    }
    if (matchesOwner(filter, BOB_ID) || JSON.stringify(filter).includes("11B")) {
      const doc = {
        className: "11B",
        Monday: [
          { period: 1, subject: "World History", startTime: "08:30", endTime: "09:30", teacher: "Prof. Sen", room: "H-12" },
          { period: 2, subject: "Literature", startTime: "10:00", endTime: "11:00", teacher: "Ms. Roy", room: "L-04" },
        ],
        Tuesday: [],
        Wednesday: [],
        Thursday: [],
        Friday: [],
        Saturday: [],
        Sunday: [],
      };
      return makeChain({ ...doc, toObject: () => doc });
    }
    return makeChain(null);
  };

  StudentProgress.findOne = (filter = {}) => {
    const uid = String(filter.userId || "");
    if (uid === ALICE_ID) {
      return makeChain({
        userId: ALICE_ID,
        overallProgressPercent: 64,
        studyStreakDays: 4,
        totalStudyMinutes: 310,
        subjects: [
          {
            subject: "Physics",
            progressPercent: 42,
            weakTopics: ["Refraction", "Snell's Law"],
          },
          {
            subject: "Mathematics",
            progressPercent: 86,
            weakTopics: [],
          },
        ],
      });
    }
    if (uid === BOB_ID) {
      return makeChain({
        userId: BOB_ID,
        overallProgressPercent: 95,
        studyStreakDays: 9,
        totalStudyMinutes: 540,
        subjects: [
          {
            subject: "World History",
            progressPercent: 95,
            weakTopics: [],
          },
        ],
      });
    }
    return makeChain(null);
  };

  const aliceAttempt = {
    _id: new mongoose.Types.ObjectId(),
    userId: ALICE_ID,
    quizId: OPTICS_QUIZ_ID,
    quizTitle: "Optics & Refraction Quiz",
    subject: "Physics",
    topic: "Refraction",
    score: 40,
    correctAnswers: 2,
    totalQuestions: 5,
    weakTopics: ["Refraction", "Snell's Law"],
    answers: [
      {
        question: "Which equation states Snell's Law of refraction?",
        selectedOption: "n1 / sin(theta1) = n2",
        correctOption: "n1 sin(theta1) = n2 sin(theta2)",
        isCorrect: false,
        topic: "Snell's Law",
      },
      {
        question: "Why does light bend toward the normal entering glass from air?",
        selectedOption: "Speed increases",
        correctOption: "Phase speed decreases in denser media",
        isCorrect: false,
        topic: "Refraction",
      },
      {
        question: "What is the law of reflection?",
        selectedOption: "Angle of incidence equals angle of reflection",
        correctOption: "Angle of incidence equals angle of reflection",
        isCorrect: true,
        topic: "Reflection",
      },
    ],
    createdAt: new Date("2026-11-22T15:30:00Z"),
  };

  const bobAttempt = {
    _id: new mongoose.Types.ObjectId(),
    userId: BOB_ID,
    quizId: HISTORY_QUIZ_ID,
    quizTitle: "Industrial Revolution Mastery Quiz",
    subject: "World History",
    topic: "Steam Power",
    score: 95,
    correctAnswers: 19,
    totalQuestions: 20,
    weakTopics: [],
    answers: [
      {
        question: "Who improved the separate-condenser steam engine in 1769?",
        selectedOption: "James Watt",
        correctOption: "James Watt",
        isCorrect: true,
        topic: "Steam Power",
      },
    ],
    createdAt: new Date("2026-11-22T16:00:00Z"),
  };

  QuizAttempt.find = (filter = {}) => {
    const uid = String(filter.userId || "");
    if (uid === ALICE_ID) return makeChain([aliceAttempt]);
    if (uid === BOB_ID) return makeChain([bobAttempt]);
    return makeChain([]);
  };

  QuizAttempt.findOne = (filter = {}) => {
    const uid = String(filter.userId || "");
    if (uid === ALICE_ID) return makeChain(aliceAttempt);
    if (uid === BOB_ID) return makeChain(bobAttempt);
    return makeChain(null);
  };

  QuizAttempt.aggregate = async (pipeline = []) => {
    const serialized = JSON.stringify(pipeline);
    if (serialized.includes(ALICE_ID)) {
      return [
        { _id: "Physics", averageScore: 40, attempts: 1, latestAt: new Date("2026-11-22T15:30:00Z") },
        { _id: "Mathematics", averageScore: 86, attempts: 2, latestAt: new Date("2026-11-20T15:30:00Z") },
      ];
    }
    if (serialized.includes(BOB_ID)) {
      return [{ _id: "World History", averageScore: 95, attempts: 1, latestAt: new Date("2026-11-22T16:00:00Z") }];
    }
    return [];
  };

  QuizAttempt.distinct = async (_field, filter = {}) => {
    const uid = String(filter.userId || "");
    if (uid === ALICE_ID) return ["Physics", "Mathematics"];
    if (uid === BOB_ID) return ["World History"];
    return [];
  };

  Recording.find = () => makeChain([]);

  Assignment.find = (filter = {}) => {
    const serialized = JSON.stringify(filter);
    if (serialized.includes("quiz.0")) {
      return makeChain([
        { _id: OPTICS_QUIZ_ID, title: "Optics & Refraction Practice Set", subject: "Physics", topic: "Refraction" },
      ]);
    }
    if (matchesOwner(filter, ALICE_ID) || serialized.includes("10A")) {
      return makeChain([
        {
          title: "Ray Diagrams Problem Set",
          subject: "Physics",
          dueDate: new Date("2026-11-26T18:00:00Z"),
          status: "pending",
          description: "Solve 10 lens and prism ray-tracing problems.",
        },
      ]);
    }
    if (matchesOwner(filter, BOB_ID) || serialized.includes("11B")) {
      return makeChain([
        {
          title: "Primary Sources Essay",
          subject: "World History",
          dueDate: new Date("2026-11-28T18:00:00Z"),
          status: "pending",
          description: "Analyze 19th-century parliamentary factory reports.",
        },
      ]);
    }
    return makeChain([]);
  };

  Assignment.distinct = async () => ["Physics", "Mathematics"];
  StudySession.find = () => makeChain([]);

  Exam.find = (filter = {}) => {
    const serialized = JSON.stringify(filter);
    if (matchesOwner(filter, ALICE_ID) || serialized.includes("10A")) {
      return makeChain([
        {
          title: "Physics Midterm Exam",
          subject: "Physics",
          examDate: new Date("2026-11-28T09:00:00Z"),
          syllabusTopics: ["Refraction", "Snell's Law", "Lenses", "Human Eye"],
          durationMinutes: 90,
        },
      ]);
    }
    if (matchesOwner(filter, BOB_ID) || serialized.includes("11B")) {
      return makeChain([
        {
          title: "Modern European History Exam",
          subject: "World History",
          examDate: new Date("2026-11-30T09:00:00Z"),
          syllabusTopics: ["Industrial Revolution", "Congress of Vienna"],
          durationMinutes: 120,
        },
      ]);
    }
    return makeChain([]);
  };

  StudyPlan.find = () => makeChain([]);

  ARLesson.find = () =>
    makeChain([
      {
        title: "Human Eye & Optics",
        subject: "Biology",
        grade: "10",
        summary: "Structure of retina, cornea, and crystalline lens.",
        learningObjectives: ["Trace light refraction onto the retina"],
      },
    ]);

  LiveSession.find = () => makeChain([]);
  AiAuditLog.create = async () => ({});

  const realAxiosGet = savedModels.axiosGet.bind(axios);
  axios.get = async (url, config) => {
    const target = String(url);
    if (target.startsWith("https://api.crossref.org/works")) {
      if (researchShouldReturnEmpty) {
        return { status: 200, data: { message: { items: [] } } };
      }
      return {
        status: 200,
        data: {
          message: {
            items: [
              {
                title: ["Improving Students' Learning With Effective Learning Techniques: Spaced Practice"],
                URL: "https://doi.org/10.1177/1529100612453266",
                DOI: "10.1177/1529100612453266",
                "container-title": ["Psychological Science in the Public Interest"],
                issued: { "date-parts": [[2013]] },
              },
            ],
          },
        },
      };
    }
    if (target.startsWith("https://en.wikipedia.org/w/api.php")) {
      if (researchShouldReturnEmpty) {
        return { status: 200, data: { query: { search: [] } } };
      }
      return {
        status: 200,
        data: {
          query: {
            search: [
              {
                title: "Spaced repetition",
                snippet: "<span>Spaced repetition is an evidence-based learning technique using increasing review intervals.</span>",
              },
            ],
          },
        },
      };
    }
    return realAxiosGet(url, config);
  };
}

function signUserToken(userId) {
  return jwt.sign({ id: userId }, process.env.JWT_SECRET, { expiresIn: "1h" });
}

function startMockOpenAIProvider() {
  return new Promise((resolve) => {
    const state = { requests: [], mode: "ok" };
    const server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        if (req.url === "/v1/models") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ data: [{ id: "gpt-4o-mini" }] }));
          return;
        }
        if (req.url !== "/v1/chat/completions") {
          res.writeHead(404, { "Content-Type": "text/html" });
          res.end("<html>Not Found</html>");
          return;
        }

        if (state.mode === "auth_fail") {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { message: "Incorrect API key sk-secret-leak" } }));
          return;
        }
        if (state.mode === "rate_limit") {
          res.writeHead(429, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { message: "Rate limit exceeded" } }));
          return;
        }

        const payload = JSON.parse(raw || "{}");
        state.requests.push(payload);
        const allText = (payload.messages || []).map((m) => m.content).join("\n");
        const lastUserMsg = (payload.messages || []).filter((m) => m.role === "user").pop()?.content || "";

        let answer = "";
        if (/photosynthesis/i.test(lastUserMsg)) {
          answer =
            "Photosynthesis is the biological process by which green plants convert light energy, water, and carbon dioxide into glucose and oxygen inside chloroplasts.";
        } else if (/classes do i have today/i.test(lastUserMsg)) {
          if (allText.includes("Mathematics") && allText.includes("Dr. Raman")) {
            answer =
              "Today's classes for Class 10A:\n- Period 1 (09:00–10:00): Mathematics with Dr. Raman in Room 204\n- Period 2 (10:15–11:15): Physics with Prof. Nair in Lab 3\nFree study slot: 11:15–17:00.";
          } else if (allText.includes("World History") && allText.includes("Prof. Sen")) {
            answer =
              "Today's classes for Class 11B:\n- Period 1 (08:30–09:30): World History with Prof. Sen in Room H-12\n- Period 2 (10:00–11:00): Literature with Ms. Roy in Room L-04.";
          } else {
            answer =
              "You have no scheduled classes recorded on your timetable for today. Check your timetable view to add or update periods.";
          }
        } else if (/what should i study today/i.test(lastUserMsg)) {
          answer =
            "Today's Study Plan:\n1. Priority Weak Area — Physics (40% quiz average, weak topics: Refraction & Snell's Law).\n2. Upcoming Assessment — Physics Midterm Exam & Ray Diagrams Problem Set.\n3. Recommended Window — Use your 11:15–17:00 free slot after Physics Lab 3.";
        } else if (/analyze my last quiz/i.test(lastUserMsg)) {
          if (allText.includes("Optics & Refraction Quiz")) {
            answer =
              "Last Quiz Analysis — Optics & Refraction Quiz (Physics): Score 40% (2/5).\n- Strong topic: Reflection.\n- Missed topics: Snell's Law (n1 sin(theta1) = n2 sin(theta2)) and Refraction in denser media.\n- Next step: Review Unit 4 Optics notes and complete the Optics & Refraction Practice Set.";
          } else if (allText.includes("Industrial Revolution Mastery Quiz")) {
            answer =
              "Last Quiz Analysis — Industrial Revolution Mastery Quiz (World History): Score 95% (19/20).\n- Strong topic: Steam Power.";
          } else {
            answer =
              "You have no completed quiz attempts saved in EduNova yet. Take a practice quiz first so I can analyze your score and topic breakdown.";
          }
        } else if (/study plan/i.test(lastUserMsg)) {
          answer =
            "5-Day Physics Midterm Study Plan:\n- Day 1 (11:15–12:30): Snell's Law & refractive index derivations.\n- Day 2: Refraction ray diagrams & Ray Diagrams Problem Set.\n- Day 3: Thin Lenses & Human Eye syllabus objectives.\n- Day 4: Mathematics Trigonometry review + Physics practice quiz.\n- Day 5: Full 90-minute timed Physics Midterm mock exam.";
        } else if (/subjects am i enrolled/i.test(lastUserMsg)) {
          answer =
            "Enrolled Subjects & Syllabus:\n- Mathematics (86% progress)\n- Physics (42% progress: Unit 4 Optics — Refraction, Snell's Law, Lenses)\n- Biology (Human Eye & Optics curriculum lesson).";
        } else if (/spaced repetition/i.test(lastUserMsg)) {
          if (allText.includes("10.1177/1529100612453266")) {
            answer =
              "Verified Research Summary on Spaced Repetition:\n- Dunlosky & Rawson (2013), Psychological Science in the Public Interest (https://doi.org/10.1177/1529100612453266), show distributed practice and retrieval testing significantly boost long-term STEM retention [S1].\n- Spaced repetition schedules reviews at expanding intervals [S2].";
          } else {
            answer =
              "External verified research sources could not be retrieved right now. General academic guidance: space review sessions across increasing intervals rather than cramming.";
          }
        } else {
          answer = `Grounded response for: ${lastUserMsg}`;
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            id: "chatcmpl-test",
            choices: [{ index: 0, message: { role: "assistant", content: answer } }],
          })
        );
      });
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, state }));
  });
}

function startCustomServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

function parseSseEvents(rawBody) {
  return rawBody
    .split(/\r?\n\r?\n/)
    .map((block) =>
      block
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n")
    )
    .filter(Boolean)
    .map((txt) => JSON.parse(txt));
}

let appServer;
let appOrigin;
let openAiMock;

before(async () => {
  installMockDatabase();
  openAiMock = await startMockOpenAIProvider();
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use("/api/ai", aiRoutes);
  appServer = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  appOrigin = `http://127.0.0.1:${appServer.address().port}`;
});

after(async () => {
  await new Promise((r) => appServer?.close(r));
  await new Promise((r) => openAiMock?.server?.close(r));

  mongoose.connection.readyState = savedModels.readyState;
  mongoose.connection.db = savedModels.db;
  User.findById = savedModels.userFindById;
  Timetable.findOne = savedModels.timetableFindOne;
  StudentProgress.findOne = savedModels.progressFindOne;
  QuizAttempt.find = savedModels.attemptFind;
  QuizAttempt.findOne = savedModels.attemptFindOne;
  QuizAttempt.aggregate = savedModels.attemptAggregate;
  QuizAttempt.distinct = savedModels.attemptDistinct;
  Assignment.find = savedModels.assignmentFind;
  Assignment.distinct = savedModels.assignmentDistinct;
  Exam.find = savedModels.examFind;
  StudyPlan.find = savedModels.planFind;
  StudySession.find = savedModels.sessionFind;
  Recording.find = savedModels.recordingFind;
  ARLesson.find = savedModels.lessonFind;
  LiveSession.find = savedModels.liveFind;
  AiAuditLog.create = savedModels.auditCreate;
  axios.get = savedModels.axiosGet;

  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  Object.assign(process.env, savedEnv);
});

describe("MASTER FIX Scenarios 1–4: AI Status Normalization, Configuration & Failure Handling", () => {
  test("Scenario 1: Valid AI health response returns structured healthy JSON & verified capabilities", async () => {
    delete process.env.AI_ENGINE_URL;
    process.env.OPENAI_API_KEY = "sk-test-valid-key";
    process.env.OPENAI_BASE_URL = `http://127.0.0.1:${openAiMock.port}/v1`;
    process.env.OPENAI_MODEL = "gpt-4o-mini";

    const res = await fetch(`${appOrigin}/api/ai/health`, {
      headers: { Authorization: `Bearer ${signUserToken(ALICE_ID)}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.status, "healthy");
    assert.equal(body.configured, true);
    assert.equal(body.modelReady, true);
    assert.deepEqual(body.capabilities, {
      chat: true,
      timetable: true,
      subjects: true,
      quizAnalysis: true,
      studyPlanning: true,
      research: true,
    });
    assert.ok(!JSON.stringify(body).includes("sk-test-valid-key"), "API key must never leak in health payload");
  });

  test("Scenario 2: Non-JSON 200 HTML or malformed status response maps to 502 INVALID_STATUS_RESPONSE (never 'AI status response is invalid')", async () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.AI_API_KEY;

    const html200 = await startCustomServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<!doctype html><html><body>Welcome</body></html>");
    });
    process.env.AI_ENGINE_URL = `http://127.0.0.1:${html200.port}`;

    const resHtml = await fetch(`${appOrigin}/api/ai/health`, {
      headers: { Authorization: `Bearer ${signUserToken(ALICE_ID)}` },
    });
    const bodyHtml = await resHtml.json();
    await new Promise((r) => html200.server.close(r));

    assert.equal(resHtml.status, 502);
    assert.equal(bodyHtml.status, "invalid_response");
    assert.equal(bodyHtml.errorCode, "INVALID_STATUS_RESPONSE");
    assert.equal(bodyHtml.error.message, "Unable to verify AI service status");
    assert.ok(!JSON.stringify(bodyHtml).includes("AI status response is invalid"));
    assert.equal(bodyHtml.capabilities.timetable, false);

    const malformedJson = await startCustomServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ greeting: "hello world" }));
    });
    process.env.AI_ENGINE_URL = `http://127.0.0.1:${malformedJson.port}`;

    const resMalformed = await fetch(`${appOrigin}/api/ai/health`, {
      headers: { Authorization: `Bearer ${signUserToken(ALICE_ID)}` },
    });
    const bodyMalformed = await resMalformed.json();
    await new Promise((r) => malformedJson.server.close(r));

    assert.equal(resMalformed.status, 502);
    assert.equal(bodyMalformed.status, "invalid_response");
    assert.equal(bodyMalformed.errorCode, "INVALID_STATUS_RESPONSE");
    assert.ok(!JSON.stringify(bodyMalformed).includes("AI status response is invalid"));
  });

  test("Scenario 3: Missing AI configuration returns 503 CONFIG_FAILED on both /health and /chat", async () => {
    process.env.AI_ENGINE_URL = "";
    delete process.env.OPENAI_API_KEY;
    delete process.env.AI_API_KEY;

    const healthRes = await fetch(`${appOrigin}/api/ai/health`, {
      headers: { Authorization: `Bearer ${signUserToken(ALICE_ID)}` },
    });
    const healthBody = await healthRes.json();
    assert.equal(healthRes.status, 503);
    assert.equal(healthBody.status, "not_configured");
    assert.equal(healthBody.configured, false);
    assert.equal(healthBody.errorCode, "CONFIG_FAILED");
    assert.equal(healthBody.capabilities.chat, false);

    const chatRes = await fetch(`${appOrigin}/api/ai/chat`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${signUserToken(ALICE_ID)}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ message: "Hello" }),
    });
    const chatBody = await chatRes.json();
    assert.equal(chatRes.status, 503);
    assert.equal(chatBody.error.code, "CONFIG_FAILED");
  });

  test("Scenario 4: Upstream 502 HTML Bad Gateway & provider 429/401 failures map cleanly without leaking secrets", async () => {
    delete process.env.OPENAI_API_KEY;
    const badGateway = await startCustomServer((_req, res) => {
      res.writeHead(502, { "Content-Type": "text/html" });
      res.end("<html><head><title>502 Bad Gateway</title></head><body>Render Proxy Error</body></html>");
    });
    process.env.AI_ENGINE_URL = `http://127.0.0.1:${badGateway.port}`;

    const health502 = await fetch(`${appOrigin}/api/ai/health`, {
      headers: { Authorization: `Bearer ${signUserToken(ALICE_ID)}` },
    });
    const body502 = await health502.json();
    await new Promise((r) => badGateway.server.close(r));

    assert.equal(health502.status, 503);
    assert.equal(body502.status, "unavailable");
    assert.equal(body502.errorCode, "AI_SERVICE_UNAVAILABLE");
    assert.equal(body502.error.message, "AI service is temporarily unavailable");
    assert.ok(!JSON.stringify(body502).includes("AI status response is invalid"));
    assert.ok(!JSON.stringify(body502).includes("<html>"));

    process.env.OPENAI_API_KEY = "sk-test-fallback-key";
    process.env.OPENAI_BASE_URL = `http://127.0.0.1:${openAiMock.port}/v1`;
    process.env.OPENAI_MODEL = "gpt-4o-mini";
    delete process.env.AI_ENGINE_URL;

    openAiMock.state.mode = "rate_limit";
    const res429 = await fetch(`${appOrigin}/api/ai/chat`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${signUserToken(ALICE_ID)}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ message: "Explain gravity" }),
    });
    const body429 = await res429.json();
    assert.equal(res429.status, 429);
    assert.equal(body429.error.code, "RATE_LIMITED");

    openAiMock.state.mode = "auth_fail";
    const resAuth = await fetch(`${appOrigin}/api/ai/chat`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${signUserToken(ALICE_ID)}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ message: "Explain gravity" }),
    });
    const bodyAuth = await resAuth.json();
    assert.equal(resAuth.status, 503);
    assert.equal(bodyAuth.error.code, "PROVIDER_AUTH_FAILED");
    assert.ok(!JSON.stringify(bodyAuth).includes("sk-secret-leak"));
    openAiMock.state.mode = "ok";
  });
});

describe("MASTER FIX Scenarios 5–12: Grounded Student Chat, Research & Multi-User Isolation", () => {
  before(() => {
    delete process.env.AI_ENGINE_URL;
    process.env.OPENAI_API_KEY = "sk-test-live-key";
    process.env.OPENAI_BASE_URL = `http://127.0.0.1:${openAiMock.port}/v1`;
    process.env.OPENAI_MODEL = "gpt-4o-mini";
    openAiMock.state.mode = "ok";
  });

  async function askJson(userId, message, extra = {}) {
    const res = await fetch(`${appOrigin}/api/ai/chat`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${signUserToken(userId)}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ message, ...extra }),
    });
    return { status: res.status, body: await res.json() };
  }

  async function askSse(userId, message, extra = {}) {
    const res = await fetch(`${appOrigin}/api/ai/chat`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${signUserToken(userId)}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify({ message, ...extra }),
    });
    const raw = await res.text();
    return { status: res.status, events: parseSseEvents(raw) };
  }

  test("Scenario 5: General AI chat works via both SSE and JSON with multi-turn conversation memory", async () => {
    const sse = await askSse(ALICE_ID, "Explain photosynthesis in simple terms.");
    assert.equal(sse.status, 200);
    const answerEvent = sse.events.find((e) => e.type === "answer");
    assert.ok(answerEvent, "SSE stream must emit terminal answer event");
    assert.equal(answerEvent.success, true);
    assert.match(answerEvent.message, /chloroplasts/i);
    assert.match(answerEvent.message, /glucose/i);
    assert.ok(answerEvent.conversationId);

    openAiMock.state.requests.length = 0;
    const followUp = await askJson(ALICE_ID, "Can you summarize that in one sentence?", {
      conversationId: answerEvent.conversationId,
    });
    assert.equal(followUp.status, 200);
    const sentMessages = openAiMock.state.requests[0].messages;
    assert.ok(
      sentMessages.some((m) => m.role === "assistant" && /chloroplasts/i.test(m.content)),
      "Conversation history must include previous assistant reply"
    );
  });

  test("Scenario 6: 'What classes do I have today?' returns real student schedule and handles empty timetable honestly", async () => {
    const aliceRes = await askJson(ALICE_ID, "What classes do I have today?");
    assert.equal(aliceRes.status, 200);
    assert.equal(aliceRes.body.usedInternalDb, true);
    assert.match(aliceRes.body.reply, /Mathematics/);
    assert.match(aliceRes.body.reply, /09:00/);
    assert.match(aliceRes.body.reply, /Dr\. Raman/);
    assert.match(aliceRes.body.reply, /Physics/);
    assert.match(aliceRes.body.reply, /Prof\. Nair/);
    assert.ok(aliceRes.body.internalSources.some((s) => /Schedule|Timetable|Classes/i.test(s.title)));

    const nehaRes = await askJson(NEW_STUDENT_ID, "What classes do I have today?");
    assert.equal(nehaRes.status, 200);
    assert.match(nehaRes.body.reply, /no scheduled classes/i);
    assert.doesNotMatch(nehaRes.body.reply, /Dr\. Raman|Prof\. Sen/);
  });

  test("Scenario 7: 'What should I study today?' combines schedule, weak topics, assignments & exams", async () => {
    openAiMock.state.requests.length = 0;
    const res = await askJson(ALICE_ID, "What should I study today?");
    assert.equal(res.status, 200);
    assert.equal(res.body.usedInternalDb, true);
    assert.match(res.body.reply, /Physics/);
    assert.match(res.body.reply, /Refraction|Snell's Law/);
    assert.match(res.body.reply, /Physics Midterm Exam/);
    assert.match(res.body.reply, /11:15/);

    const promptContext = JSON.stringify(openAiMock.state.requests[0].messages);
    assert.match(promptContext, /Ray Diagrams Problem Set/);
    assert.match(promptContext, /Physics Midterm Exam/);
    assert.match(promptContext, /weakSubjects/);
  });

  test("Scenario 8: 'Analyze my last quiz.' inspects actual missed questions & handles zero-quiz student honestly", async () => {
    openAiMock.state.requests.length = 0;
    const aliceQuiz = await askJson(ALICE_ID, "Analyze my last quiz.");
    assert.equal(aliceQuiz.status, 200);
    assert.equal(aliceQuiz.body.usedInternalDb, true);
    assert.match(aliceQuiz.body.reply, /Optics & Refraction Quiz/);
    assert.match(aliceQuiz.body.reply, /40%/);
    assert.match(aliceQuiz.body.reply, /Snell's Law/);
    assert.match(aliceQuiz.body.reply, /Reflection/);

    const grounded = JSON.stringify(openAiMock.state.requests[0].messages);
    assert.match(grounded, /n1 sin\(theta1\) = n2 sin\(theta2\)/);

    const nehaQuiz = await askJson(NEW_STUDENT_ID, "Analyze my last quiz.");
    assert.equal(nehaQuiz.status, 200);
    assert.match(nehaQuiz.body.reply, /no completed quiz attempts/i);
    assert.doesNotMatch(nehaQuiz.body.reply, /40%|95%|Optics/);
  });

  test("Scenario 9: 'Make me an exam study plan' builds multi-day plan grounded in syllabus, exams & timetable", async () => {
    openAiMock.state.requests.length = 0;
    const planRes = await askJson(ALICE_ID, "Create a 5-day exam study plan based on my syllabus and weak topics.");
    assert.equal(planRes.status, 200);
    assert.equal(planRes.body.usedInternalDb, true);
    for (const dayLabel of ["Day 1", "Day 2", "Day 3", "Day 4", "Day 5"]) {
      assert.ok(planRes.body.reply.includes(dayLabel), `Study plan must include ${dayLabel}`);
    }
    assert.match(planRes.body.reply, /Snell's Law/);
    assert.match(planRes.body.reply, /Human Eye/);

    const grounded = JSON.stringify(openAiMock.state.requests[0].messages);
    assert.match(grounded, /Unit 4 Optics/);
    assert.match(grounded, /Physics Midterm Exam/);
  });

  test("Scenario 10: Subject-aware question grounds answer in student's enrolled subjects, curriculum & mastery", async () => {
    const subjRes = await askJson(ALICE_ID, "What subjects am I enrolled in and what topics are in my syllabus?");
    assert.equal(subjRes.status, 200);
    assert.equal(subjRes.body.usedInternalDb, true);
    assert.match(subjRes.body.reply, /Mathematics/);
    assert.match(subjRes.body.reply, /Physics/);
    assert.match(subjRes.body.reply, /Biology/);
    assert.match(subjRes.body.reply, /Human Eye & Optics/);
  });

  test("Scenario 11: Verified research query attaches real academic sources and handles empty search honestly", async () => {
    researchShouldReturnEmpty = false;
    const res = await askJson(ALICE_ID, "Find verified research sources on spaced repetition for exam preparation.");
    assert.equal(res.status, 200);
    assert.equal(res.body.usedWeb, true);
    assert.ok(Array.isArray(res.body.sources) && res.body.sources.length >= 2);
    assert.equal(res.body.sources[0].url, "https://doi.org/10.1177/1529100612453266");
    assert.match(res.body.sources[0].title, /Spaced Practice/);
    assert.match(res.body.reply, /Dunlosky/);
    assert.match(res.body.reply, /10\.1177\/1529100612453266/);

    researchShouldReturnEmpty = true;
    const emptyRes = await askJson(ALICE_ID, "Find verified research sources on spaced repetition for exam preparation.");
    researchShouldReturnEmpty = false;
    assert.equal(emptyRes.status, 200);
    assert.equal(emptyRes.body.usedWeb, false);
    assert.equal(emptyRes.body.sources.length, 0);
    assert.match(emptyRes.body.reply, /could not be retrieved/i);
  });

  test("Scenario 12: Strict user-data isolation between Alice and Bob (DB records + conversationId)", async () => {
    const aliceSchedule = await askJson(ALICE_ID, "What classes do I have today?");
    const bobSchedule = await askJson(BOB_ID, "What classes do I have today?");

    assert.match(aliceSchedule.body.reply, /Mathematics/);
    assert.doesNotMatch(aliceSchedule.body.reply, /World History|Literature|Prof\. Sen/);

    assert.match(bobSchedule.body.reply, /World History/);
    assert.match(bobSchedule.body.reply, /Literature/);
    assert.doesNotMatch(bobSchedule.body.reply, /Mathematics|Physics|Dr\. Raman|Prof\. Nair/);

    const bobQuiz = await askJson(BOB_ID, "Analyze my last quiz.");
    assert.match(bobQuiz.body.reply, /Industrial Revolution Mastery Quiz/);
    assert.match(bobQuiz.body.reply, /95%/);
    assert.doesNotMatch(bobQuiz.body.reply, /Optics|40%|Snell/);

    openAiMock.state.requests.length = 0;
    await askJson(ALICE_ID, "What classes do I have today?", {
      conversationId: bobQuiz.body.conversationId,
    });
    const alicePromptPayload = JSON.stringify(openAiMock.state.requests[0].messages);
    assert.doesNotMatch(
      alicePromptPayload,
      /Industrial Revolution Mastery Quiz/,
      "Alice must never receive Bob's conversation memory even if passing Bob's conversationId"
    );
  });
});
