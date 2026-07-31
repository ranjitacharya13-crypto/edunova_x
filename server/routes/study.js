// server/routes/study.js
// Study-material file storage backed by Postgres bytea columns.
// (Replaces the old MongoDB GridFS "study_files" / "study_thumbs" buckets.)
const express = require("express");
const multer = require("multer");
const sharp = require("sharp");
const pdfThumbnail = require("pdf-thumbnail");
const path = require("path");
const auth = require("../middleware/auth");
const fileStore = require("../models/fileStore");
const { isUuid } = require("../db");

const router = express.Router();
const storage = multer.memoryStorage();
const upload = multer({ storage });

const FILE_TABLE = "study_files";
const THUMB_TABLE = "study_thumbs";

// helpers
function adminOnly(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "Not authenticated" });
  if (req.user.role !== "admin") {
    return res.status(403).json({ error: "Admin only" });
  }
  next();
}

function teacherOrAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "Not authenticated" });
  if (req.user.role !== "admin" && req.user.role !== "teacher") {
    return res.status(403).json({ error: "Teacher or admin only" });
  }
  next();
}

const EXT_CONTENT_TYPES = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
};

function getContentType(filename, fallback) {
  const ext = path.extname(filename || "").toLowerCase();
  return EXT_CONTENT_TYPES[ext] || fallback || "application/octet-stream";
}

// helper
function streamToBuffer(streamObj) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    streamObj.on("data", (c) => chunks.push(c));
    streamObj.on("end", () => resolve(Buffer.concat(chunks)));
    streamObj.on("error", reject);
  });
}

async function streamFile(req, res, { forceDownload = false } = {}) {
  if (!isUuid(req.params.id)) {
    return res.status(404).json({ error: "File not found" });
  }
  const fileDoc = await fileStore.getFileMeta(FILE_TABLE, req.params.id);
  if (!fileDoc) return res.status(404).json({ error: "File not found" });

  const contentType = getContentType(fileDoc.filename, fileDoc.contentType);
  res.setHeader("Content-Type", contentType);
  res.setHeader("Accept-Ranges", "bytes");

  const name = req.query.name || fileDoc.filename || "file";
  if (forceDownload || req.query.download) {
    res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
  } else {
    res.setHeader("Content-Disposition", `inline; filename="${name}"`);
  }

  const fileSize = fileDoc.length || 0;
  const range = req.headers.range;

  if (range && fileSize > 0) {
    const bytesPrefix = "bytes=";
    if (!range.startsWith(bytesPrefix)) {
      return res.status(416).end();
    }

    const parts = range.replace(bytesPrefix, "").split("-");
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

    if (
      Number.isNaN(start) ||
      Number.isNaN(end) ||
      start > end ||
      end >= fileSize
    ) {
      res.setHeader("Content-Range", `bytes */${fileSize}`);
      return res.status(416).end();
    }

    const chunkSize = end - start + 1;
    const chunk = await fileStore.getFileRange(FILE_TABLE, fileDoc.id, start, end);
    if (!chunk) return res.status(404).json({ error: "File not found" });

    res.status(206);
    res.setHeader("Content-Range", `bytes ${start}-${end}/${fileSize}`);
    res.setHeader("Content-Length", chunkSize);
    return res.end(chunk);
  }

  const data = await fileStore.getFileData(FILE_TABLE, fileDoc.id);
  if (!data) return res.status(404).json({ error: "File not found" });

  if (fileSize > 0) {
    res.setHeader("Content-Length", data.length);
  }
  return res.end(data);
}

// Upload (teacher / admin)
router.post("/", auth, teacherOrAdmin, upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    const file = req.file;

    // generate thumbnail buffer if image or pdf
    let thumbBuffer = null;
    try {
      if (file.mimetype.startsWith("image/")) {
        thumbBuffer = await sharp(file.buffer).resize(240).jpeg().toBuffer();
      } else if (file.mimetype === "application/pdf") {
        const t = await pdfThumbnail(file.buffer, { resize: { width: 240 } });
        if (Buffer.isBuffer(t)) thumbBuffer = t;
        else thumbBuffer = await streamToBuffer(t);
      }
    } catch (thumbErr) {
      console.warn("Study thumbnail generation failed", thumbErr);
    }

    const contentType = getContentType(
      file.originalname,
      file.mimetype && file.mimetype !== "application/octet-stream"
        ? file.mimetype
        : undefined
    );

    const saved = await fileStore.saveFile(FILE_TABLE, {
      filename: file.originalname,
      contentType,
      data: file.buffer,
      metadata: {
        uploadedBy: req.user.email,
        role: req.user.role,
        originalname: file.originalname,
        hasThumb: !!thumbBuffer,
      },
    });

    if (thumbBuffer) {
      try {
        await fileStore.saveThumb(THUMB_TABLE, {
          parentFileId: saved.id,
          data: thumbBuffer,
        });
      } catch (e) {
        console.warn("Study thumb save err", e);
      }
    }

    return res.json({ id: saved.id, filename: file.originalname });
  } catch (e) {
    console.error("Study upload route error", e);
    return res.status(500).json({ error: "Server upload error" });
  }
});

// List files (public)
router.get("/", async (req, res) => {
  try {
    const files = await fileStore.listFiles(FILE_TABLE);
    const list = files.map((f) => ({
      _id: f._id,
      filename: f.filename,
      contentType: f.contentType,
      uploadDate: f.uploadDate,
      length: f.length,
      metadata: f.metadata,
    }));
    res.json(list);
  } catch (e) {
    console.error("Study list error", e);
    res.status(500).json({ error: "Failed to list files" });
  }
});

// Preview / stream file inline (anyone)
router.get("/:id/preview", async (req, res) => {
  try {
    await streamFile(req, res, { forceDownload: false });
  } catch (e) {
    console.error("Study preview error", e);
    res.status(500).json({ error: "Preview failed" });
  }
});

// Download (force attachment)
router.get("/:id/download", async (req, res) => {
  try {
    await streamFile(req, res, { forceDownload: true });
  } catch (e) {
    console.error("Study download error", e);
    res.status(500).json({ error: "Download failed" });
  }
});

// Delete (admin only)
router.delete("/:id", auth, adminOnly, async (req, res) => {
  try {
    if (!isUuid(req.params.id)) {
      return res.status(404).json({ error: "File not found" });
    }
    await fileStore.deleteFile(FILE_TABLE, req.params.id);
    // parent_file_id has ON DELETE CASCADE; this mirrors the old explicit cleanup.
    await fileStore.deleteThumbsByParent(THUMB_TABLE, req.params.id);
    return res.json({ success: true });
  } catch (e) {
    console.error("Study delete error", e);
    return res.status(500).json({ error: "Delete failed" });
  }
});

module.exports = router;
