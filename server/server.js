// server/server.js
// Deploy Trigger: 2026-08-18T17:00:00Z — API-only, no frontend/dist serving
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") }); // load server/.env reliably
const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const http = require("http");
const { Server } = require("socket.io");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const User = require("./models/User");
const ContactMessage = require("./models/ContactMessage");
const nodemailer = require("nodemailer");

// import routes
const authRoutes = require("./routes/auth");
const syllabusRoutes = require("./routes/syllabus");
const timetableRoute = require("./routes/timetable"); // Student timetable
const teacherTimetableRoute = require("./routes/teacherTimetable"); // Teacher timetable
const studyRoutes = require("./routes/study"); // Study materials
const assignmentRoutes = require("./routes/assignments"); // Assignments + quiz
const adminRoutes = require("./routes/admin");
const aiRoutes = require("./routes/ai");

const app = express();
const server = http.createServer(app);

// ==========================
// CORS CONFIG (IMPORTANT)
// ==========================
// Production: set CORS_ORIGIN to a comma-separated list of allowed browser
// origins (e.g. "https://edunova-frontend.onrender.com"). FRONTEND_URL is an
// optional single-origin alias. When unset, only the committed production and
// local-development origins below are allowed.
const corsOrigin = [process.env.CORS_ORIGIN, process.env.FRONTEND_URL]
  .filter(Boolean)
  .join(",")
  .split(",")
  .map((o) => o.trim().replace(/\/+$/, "")) // tolerate a trailing slash in the env var
  .filter(Boolean);

// The Cloudflare Workers frontend is the production origin and must ALWAYS be
// allowed, even if CORS_ORIGIN is misconfigured in the dashboard — otherwise a
// typo silently takes the whole product offline with opaque browser errors.
const PRODUCTION_ORIGIN = "https://edunova-x.ranjitacharya13.workers.dev";

// Local development origins are kept separate from production ones.
const developmentOrigins = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:4173",
  "http://127.0.0.1:4173",
];

const allowedOrigins = Array.from(
  new Set([...corsOrigin, PRODUCTION_ORIGIN, ...developmentOrigins])
);

// Cloudflare Workers *.workers.dev preview deployments (e.g. a versioned
// preview like https://<hash>-edunova-x.<account>.workers.dev) are allowed so
// staged frontend builds can talk to the API without a redeploy of the backend.
const isAllowedOrigin = (origin) => {
  const normalized = String(origin).replace(/\/+$/, "");
  if (allowedOrigins.includes(normalized)) return true;
  return /^https:\/\/[a-z0-9-]+\.ranjitacharya13\.workers\.dev$/i.test(normalized);
};

const corsOptions = {
  origin: (origin, callback) => {
    // `!origin` covers same-origin requests, curl/health checks, mobile
    // (Capacitor) and the Electron desktop shell — none of which send Origin.
    if (!origin || isAllowedOrigin(origin)) return callback(null, true);
    return callback(new Error(`CORS origin not allowed: ${origin}`));
  },
  credentials: false,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  optionsSuccessStatus: 204,
};

app.use(cors(corsOptions));
// Answer preflight OPTIONS for every route. Express 5 no longer accepts a bare
// "*" string path, so use a RegExp that matches all paths.
app.options(/.*/, cors(corsOptions));

// ==========================
// SOCKET.IO (SIGNALING)
// ==========================
// WebRTC media is peer-to-peer; this server is for signaling + chat only.
const io = new Server(server, {
  cors: corsOptions,
});

const CHAT_HISTORY_LIMIT = 200;
const roomChat = new Map(); // room -> [{ id, text, user, createdAt }]

function getRoomHistory(room) {
  if (!roomChat.has(room)) roomChat.set(room, []);
  return roomChat.get(room);
}

io.on("connection", (socket) => {
  console.log("client connected", socket.id);

  socket.on("join", (room) => {
    if (!room) return;
    socket.join(room);
    socket.to(room).emit("peer-joined", { id: socket.id });

    const history = getRoomHistory(room);
    socket.emit("chat-history", { room, messages: history });
  });

  socket.on("offer", ({ room, offer }) => {
    if (!room) return;
    socket.to(room).emit("offer", { offer });
  });

  socket.on("answer", ({ room, answer }) => {
    if (!room) return;
    socket.to(room).emit("answer", { answer });
  });

  socket.on("ice-candidate", ({ room, candidate }) => {
    if (!room) return;
    socket.to(room).emit("ice-candidate", { candidate });
  });

  socket.on("chat-send", ({ room, text, user }) => {
    if (!room) return;
    const cleaned = String(text || "").trim();
    if (!cleaned) return;

    const message = {
      id: `${Date.now()}_${Math.random().toString(16).slice(2)}`,
      text: cleaned.slice(0, 1000),
      user: {
        id: user?.id || null,
        name: user?.name || "User",
        role: user?.role || null,
      },
      createdAt: new Date().toISOString(),
    };

    const history = getRoomHistory(room);
    history.push(message);
    if (history.length > CHAT_HISTORY_LIMIT) history.splice(0, history.length - CHAT_HISTORY_LIMIT);

    io.to(room).emit("chat-message", { room, message });
  });

  socket.on("disconnect", () => console.log("client disconnected", socket.id));
});

// ==========================
// MIDDLEWARE
// ==========================
app.use(express.json());

// ==========================
// HEALTH CHECK (Render LB)
// ==========================
// Render's load balancer polls this path (healthCheckPath: /health in render.yaml).
// It must NOT depend on MongoDB, the AI provider, authentication, or frontend
// build artifacts. Render can therefore verify the process while dependencies
// are still connecting.
app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok", service: "edunova-api", version: "5.0.0", database: mongoose.connection.readyState === 1 ? "connected" : "disconnected" });
});

// ==========================
// EMAIL (CONTACT)
// ==========================
const contactTransporter = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 587,
  secure: false,
  auth: {
    user: process.env.EMAIL_USER,
    pass: String(process.env.EMAIL_PASS || "").replace(/\s+/g, ""),
  },
});

// ==========================
// DATABASE CONNECTION
// ==========================
const MONGO_URI = String(process.env.MONGO_URI || "").trim();

if (!MONGO_URI) {
  // Fail fast with an actionable message instead of crashing later inside
  // mongoose with "uri parameter must be a string".
  console.error(
    "❌ MONGO_URI is not set. Add it in Render → your API service → Environment " +
      "(or in server/.env for local development).\n" +
      "   The server will keep serving /health so the platform can report the " +
      "misconfiguration, but all database-backed routes will fail."
  );
} else if (!/^mongodb(\+srv)?:\/\//i.test(MONGO_URI)) {
  console.error(
    "❌ MONGO_URI is set but is not a valid MongoDB connection string " +
      "(it must start with mongodb:// or mongodb+srv://)."
  );
}

// JWT_SECRET is required for authentication to work at all.
if (!process.env.JWT_SECRET) {
  console.error(
    "❌ JWT_SECRET is not set. Login/registration will fail. " +
      "Set it in Render → your API service → Environment."
  );
}

const mongoConnection = MONGO_URI
  ? mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 15000 })
  : Promise.reject(new Error("MONGO_URI is not configured"));

mongoConnection
  .then(async () => {
    console.log("✅ MongoDB connected");
    // Add educational content idempotently; never seed or overwrite student records.
    await require("./services/arLessons").seedCurriculum();

    const adminEmail = "ranjitacharya13@gmail.com";
    const adminName = "Super Admin";
    const adminUsername = "super_admin";
    const existingAdmin = await User.findOne({ email: adminEmail });

    if (!existingAdmin && process.env.ADMIN_TEMP_PASSWORD) {
      const tempAdminPassword =
        process.env.ADMIN_TEMP_PASSWORD || crypto.randomBytes(24).toString("base64url");
      const adminPasswordHash = await bcrypt.hash(tempAdminPassword, 10);

      await new User({
        name: adminName,
        username: adminUsername,
        email: adminEmail,
        password: adminPasswordHash,
        role: "admin",
      }).save();

      console.log(`Seeded admin user: ${adminEmail}`);
      if (!process.env.ADMIN_TEMP_PASSWORD) {
        console.warn("Admin bootstrap requires a configured password; credentials are never logged.");
      }
    } else if (existingAdmin && existingAdmin.role !== "admin" && process.env.ADMIN_TEMP_PASSWORD) {
      existingAdmin.role = "admin";
      await existingAdmin.save();
      console.log(`Updated existing user role to admin: ${adminEmail}`);
    }

    // Create demo accounts if they don't exist (disable with `SEED_DEMO_USERS=false`).
    if (process.env.NODE_ENV !== "production" && String(process.env.SEED_DEMO_USERS || "").toLowerCase() === "true") {
      const demoUsers = [
        {
          name: "Demo Teacher",
          username: "teacher_demo",
          email: "teacher@edunova.com",
          password: "123456",
          role: "teacher",
        },
        {
          name: "Demo Student",
          username: "student_demo",
          email: "student@edunova.com",
          password: "123456",
          role: "student",
        },
      ];

      for (const demo of demoUsers) {
        const existing = await User.findOne({ email: demo.email });
        if (existing) continue;

        const hashedPassword = await bcrypt.hash(demo.password, 10);
        await new User({ ...demo, password: hashedPassword }).save();
        console.log(`✅ Seeded demo user: ${demo.email}`);
      }
    }
  })
  .catch((err) => {
    // Do NOT exit: the process must keep listening so Render's health check
    // reports a live-but-degraded service (and shows this log) instead of an
    // opaque "no open ports detected" restart loop.
    console.error("❌ MongoDB connection failed:", err.message);
    if (/Authentication failed|bad auth/i.test(err.message)) {
      console.error("   → Check the username/password in MONGO_URI.");
    }
    if (/ENOTFOUND|querySrv|ETIMEDOUT|timed out/i.test(err.message)) {
      console.error(
        "   → Check the Atlas cluster hostname and that Network Access allows " +
          "0.0.0.0/0 (Render egress IPs are dynamic)."
      );
    }
  });

// Surface post-startup connection drops instead of failing silently.
mongoose.connection.on("error", (err) =>
  console.error("❌ MongoDB runtime error:", err.message)
);
mongoose.connection.on("disconnected", () =>
  console.warn("⚠️  MongoDB disconnected — driver will attempt to reconnect.")
);

// ==========================
// ROUTES
// ==========================
app.use("/api/auth", authRoutes);
app.use("/api/syllabus", syllabusRoutes);
app.use("/api/study", studyRoutes);
app.use("/api/assignments", assignmentRoutes);
app.use("/api/timetable", timetableRoute);
app.use("/api/teacher-timetable", teacherTimetableRoute);
app.use("/api/admin", adminRoutes);
app.use("/api/ai", aiRoutes);
app.use("/api/ar", require("./routes/ar"));
app.use("/api/quizzes", require("./routes/quizzes"));

// ==========================
// CONTACT ROUTE
// ==========================
app.post("/api/contact", async (req, res) => {
  try {
    const { name, email, message } = req.body || {};

    const cleanName = String(name || "").trim();
    const cleanEmail = String(email || "").trim();
    const cleanMessage = String(message || "").trim();

    if (!cleanName || !cleanEmail || !cleanMessage) {
      return res.status(400).json({
        success: false,
        message: "All fields are required",
      });
    }

    try {
      await ContactMessage.create({
        name: cleanName,
        email: cleanEmail,
        message: cleanMessage,
      });
    } catch (saveErr) {
      // Do not break existing contact flow if message persistence fails.
      console.error("Contact message save error:", saveErr);
    }

    await contactTransporter.sendMail({
      from: `"${cleanName}" <${process.env.EMAIL_USER}>`,
      to: process.env.CONTACT_RECEIVER_EMAIL || "ranjit5201314@gmail.com",
      replyTo: cleanEmail,
      subject: "New Contact Message - EduNova_X",
      text: `From: ${cleanName}\nEmail: ${cleanEmail}\n\nMessage:\n${cleanMessage}`,
    });

    return res.json({
      success: true,
      message: "Message sent successfully",
    });
  } catch (err) {
    console.error("Contact email error:", err);
    return res.status(500).json({
      success: false,
      message: "Failed to send message",
    });
  }
});

// ==========================
// TEST ROUTES (VERY IMPORTANT)
// ==========================

// Health check (USE THIS TO FIND BACKEND URL).
// Returns JSON so it is unambiguous for load balancers, uptime monitors and
// browsers. It must NOT depend on MongoDB or on any frontend build artifact.
app.get("/api/test", (req, res) => {
  res.status(200).json({ status: "OK" });
});

// ==========================
// ROOT ROUTE
// ==========================
// The React frontend is built and hosted by Cloudflare in production
// (https://edunova-x.ranjitacharya13.workers.dev). Render is an API-only
// backend and MUST NEVER serve frontend/dist/index.html: that file does not
// exist on Render (frontend/dist is gitignored and Render is backend-only),
// and every attempt to sendFile/stat it produces the repeated
// "ENOENT .../frontend/dist/index.html" errors. `/` therefore only describes
// the API. The SPA itself is served by Cloudflare's static assets / worker.
app.get("/", (req, res) => {
  res.json({
    success: true,
    service: "edunova-api",
    status: "online",
    message: "Edunova Express API Server is running.",
    endpoints: {
      test: "/api/test",
      auth: "/api/auth",
      admin: "/api/admin",
      study: "/api/study",
      timetable: "/api/timetable"
    }
  });
});

// ==========================
// 404 HANDLER (API-ONLY BACKEND)
// ==========================
// Unknown routes get a JSON 404. The backend NEVER returns the React app for
// unknown paths — Cloudflare owns frontend routing, so there is no SPA
// fallback here. This also means Render's health checks can never resolve a
// request to frontend/dist/index.html.
app.use((req, res) => {
  res.status(404).json({ error: "Route not found" });
});

// Render (and every other PaaS) injects the port to listen on via PORT.
// Binding to 0.0.0.0 is REQUIRED — binding to localhost makes the port
// unreachable from outside the container and Render reports
// "No open ports detected".
const PORT = process.env.PORT || 4000;

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`❌ Port ${PORT} is already in use.`);
  } else {
    console.error("❌ HTTP server error:", err);
  }
  process.exit(1);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Backend server listening on 0.0.0.0:${PORT}`);
});

// Keep the process alive on unexpected async errors so a single bad request
// cannot take the whole service down (and its port with it).
process.on("unhandledRejection", (reason) =>
  console.error("❌ Unhandled promise rejection:", reason)
);
process.on("uncaughtException", (err) =>
  console.error("❌ Uncaught exception:", err)
);

// Render sends SIGTERM on deploy/scale-down — shut down cleanly.
const shutdown = (signal) => () => {
  console.log(`${signal} received — shutting down gracefully.`);
  server.close(() => {
    mongoose.connection.close(false).finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(0), 10000).unref();
};
process.on("SIGTERM", shutdown("SIGTERM"));
process.on("SIGINT", shutdown("SIGINT"));
