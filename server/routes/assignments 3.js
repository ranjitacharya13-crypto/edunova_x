const express = require("express");
const multer = require("multer");
const auth = require("../middleware/auth");
const Assignment = require("../models/Assignment");
const fileStore = require("../models/fileStore");
const { isUuid } = require("../db");

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

const FILE_TABLE = "assignment_files";

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

function extractTextFromPdfBuffer(buffer) {
  // Lazy require so server can boot even if dependency is missing.
  // eslint-disable-next-line global-require
  const pdfParse = require("pdf-parse");
  return pdfParse(buffer).then((r) => (r?.text ? String(r.text) : ""));
}

const STOPWORDS = new Set([
  "the",
  "and",
  "that",
  "this",
  "with",
  "from",
  "into",
  "your",
  "you",
  "for",
  "are",
  "was",
  "were",
  "have",
  "has",
  "had",
  "will",
  "shall",
  "can",
  "could",
  "would",
  "should",
  "their",
  "there",
  "than",
  "then",
  "when",
  "where",
  "what",
  "which",
  "while",
  "because",
  "about",
  "also",
  "such",
  "these",
  "those",
  "over",
  "under",
  "between",
  "within",
  "without",
  "been",
  "being",
  "each",
  "more",
  "most",
  "some",
  "many",
  "much",
  "make",
  "made",
  "using",
  "use",
  "used",
  "one",
  "two",
  "three",
  "may",
  "might",
  "must",
  "not",
]);

function pickKeywords(text) {
  const words = String(text || "")
    .replace(/[^\p{L}\p{N}\s-]+/gu, " ")
    .split(/\s+/)
    .map((w) => w.trim())
    .filter(Boolean)
    .filter((w) => w.length >= 6)
    .map((w) => w.toLowerCase())
    .filter((w) => !STOPWORDS.has(w));

  const freq = new Map();
  for (const w of words) freq.set(w, (freq.get(w) || 0) + 1);
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 120)
    .map(([w]) => w);
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function generateQuizFromText(text, count = 5) {
  const cleaned = String(text || "")
    .replace(/\s+/g, " ")
    .replace(/[•·]+/g, " ")
    .trim();

  const sentences = cleaned
    .split(/(?<=[.?!])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 60 && s.length <= 180);

  const keywords = pickKeywords(cleaned);
  const quiz = [];
  const usedSentences = new Set();

  for (const sentence of sentences) {
    if (quiz.length >= count) break;
    if (usedSentences.has(sentence)) continue;

    const sentenceWords = sentence
      .replace(/[^\p{L}\p{N}\s-]+/gu, " ")
      .split(/\s+/)
      .map((w) => w.trim())
      .filter(Boolean)
      .map((w) => w.toLowerCase());

    const target = sentenceWords.find((w) => keywords.includes(w));
    if (!target) continue;

    const distractors = shuffle(keywords.filter((w) => w !== target)).slice(0, 3);
    if (distractors.length < 3) continue;

    const options = shuffle([target, ...distractors]).map((w) => w);
    const answerIndex = options.indexOf(target);

    const question = sentence.replace(new RegExp(`\\b${target}\\b`, "i"), "_____");
    quiz.push({
      question,
      options,
      answerIndex,
    });
    usedSentences.add(sentence);
  }

  return quiz;
}

async function streamPdfByFileId(res, fileId, name, forceDownload = false) {
  if (!isUuid(fileId)) {
    res.status(404).json({ error: "File not found" });
    return;
  }
  const fileDoc = await fileStore.getFileMeta(FILE_TABLE, fileId);
  if (!fileDoc) {
    res.status(404).json({ error: "File not found" });
    return;
  }

  res.setHeader("Content-Type", fileDoc.contentType || "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `${forceDownload ? "attachment" : "inline"}; filename="${name || fileDoc.filename || "assignment.pdf"}"`
  );

  const data = await fileStore.getFileData(FILE_TABLE, fileId);
  if (!data) {
    res.status(404).json({ error: "File not found" });
    return;
  }
  res.setHeader("Content-Length", data.length);
  res.end(data);
}

// Upload PDF + auto-generate quiz (teacher/staff/admin)
router.post("/", auth, teacherOrStaffOrAdmin, upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    const room = normalizeRoom(req.body.room);
    if (!room) return res.status(400).json({ error: "Room is required" });

    const originalname = req.file.originalname || "assignment.pdf";
    const isPdf = req.file.mimetype === "application/pdf" || /\.pdf$/i.test(originalname);
    if (!isPdf) return res.status(400).json({ error: "Only PDF is supported" });

    const titleRaw = String(req.body.title || "").trim();
    const title = titleRaw || originalname.replace(/\.pdf$/i, "");

    let extractedText = "";
    try {
      extractedText = await extractTextFromPdfBuffer(req.file.buffer);
    } catch (e) {
      console.warn("PDF text extraction failed, continuing without text", e);
    }

    const quiz = generateQuizFromText(extractedText, 6);

    const saved = await fileStore.saveFile(FILE_TABLE, {
      filename: originalname,
      contentType: "application/pdf",
      data: req.file.buffer,
      metadata: {
        room,
        title,
        uploadedBy: req.user.email,
        role: req.user.role,
      },
    });

    const doc = await Assignment.create({
      room,
      title,
      fileId: saved.id,
      filename: originalname,
      createdBy: {
        id: req.user.id,
        name: req.user.name,
        role: req.user.role,
        email: req.user.email,
      },
      quiz,
    });

    return res.json({ assignment: doc });
  } catch (e) {
    console.error("Assignment upload route error", e);
    return res.status(500).json({ error: "Server error" });
  }
});

// List assignments for a room (public)
router.get("/", async (req, res) => {
  try {
    const room = normalizeRoom(req.query.room);
    const list = await Assignment.list(room || null);
    return res.json({ assignments: list });
  } catch (e) {
    console.error("Assignment list error", e);
    return res.status(500).json({ error: "Failed to list assignments" });
  }
});

// Get assignment details (public)
router.get("/:id", async (req, res) => {
  try {
    const doc = isUuid(req.params.id)
      ? await Assignment.findById(req.params.id)
      : null;
    if (!doc) return res.status(404).json({ error: "Not found" });
    return res.json({ assignment: doc });
  } catch (e) {
    console.error("Assignment get error", e);
    return res.status(500).json({ error: "Failed to load assignment" });
  }
});

// Preview PDF (public)
router.get("/:id/preview", async (req, res) => {
  try {
    const doc = isUuid(req.params.id)
      ? await Assignment.findById(req.params.id)
      : null;
    if (!doc) return res.status(404).json({ error: "Not found" });
    await streamPdfByFileId(res, doc.fileId, req.query.name, false);
  } catch (e) {
    console.error("Assignment preview error", e);
    res.status(500).json({ error: "Preview failed" });
  }
});

// Download PDF (public)
router.get("/:id/download", async (req, res) => {
  try {
    const doc = isUuid(req.params.id)
      ? await Assignment.findById(req.params.id)
      : null;
    if (!doc) return res.status(404).json({ error: "Not found" });
    await streamPdfByFileId(res, doc.fileId, req.query.name, true);
  } catch (e) {
    console.error("Assignment download error", e);
    res.status(500).json({ error: "Download failed" });
  }
});

module.exports = router;
