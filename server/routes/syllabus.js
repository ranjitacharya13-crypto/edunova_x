const { publicMaterials } = require("../services/access");
const { prepareMetadata } = require("../services/learningMaterials");
// server/routes/syllabus.js
const express = require('express');
const multer = require('multer');
const { GridFSBucket, ObjectId } = require('mongodb');
const mongoose = require('mongoose');
const sharp = require('sharp');
const pdfThumbnail = require('pdf-thumbnail');
const stream = require('stream');
const auth = require('../middleware/auth');
const path = require('path');
// load server env explicitly so process.env.MONGO_URI is available
require('dotenv').config({ path: path.join(__dirname, '..', 'config.env') });

const router = express.Router();
const storage = multer.memoryStorage();
const upload = multer({ storage });

let db, bucket;

mongoose.connection.once("open", () => {
  db = mongoose.connection.db;
  bucket = new GridFSBucket(db, { bucketName: "syllabus_files" });
  console.log("GridFS initialized successfully");
});

const EXT_CONTENT_TYPES = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
};

function getContentType(filename, fallback) {
  const ext = path.extname(filename || '').toLowerCase();
  return EXT_CONTENT_TYPES[ext] || fallback || 'application/octet-stream';
}

async function streamFile(req, res, { forceDownload = false } = {}) {
  if (!bucket || !db) return res.status(503).json({ error: 'Storage not initialized yet' });
  const id = new ObjectId(req.params.id);
  const filesColl = db.collection('syllabus_files.files');
  const fileDoc = await filesColl.findOne({ _id: id, ...publicMaterials });
  if (!fileDoc) return res.status(404).json({ error: 'File not found' });

  const contentType = getContentType(fileDoc.filename, fileDoc.contentType);
  res.setHeader('Content-Type', contentType);
  res.setHeader('Accept-Ranges', 'bytes');

  const name = String(fileDoc.filename || "file").replace(/[\r\n"\\]/g, "_").slice(0, 180);
  if (forceDownload || req.query.download) {
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  } else {
    res.setHeader('Content-Disposition', `inline; filename="${name}"`);
  }

  const fileSize = fileDoc.length || 0;
  const range = req.headers.range;

  if (range && fileSize > 0) {
    const bytesPrefix = 'bytes=';
    if (!range.startsWith(bytesPrefix)) {
      return res.status(416).end();
    }

    const parts = range.replace(bytesPrefix, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

    if (
      Number.isNaN(start) ||
      Number.isNaN(end) ||
      start < 0 || start > end ||
      end >= fileSize
    ) {
      res.setHeader('Content-Range', `bytes */${fileSize}`);
      return res.status(416).end();
    }

    const chunkSize = end - start + 1;
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
    res.setHeader('Content-Length', chunkSize);

    const downloadStream = bucket.openDownloadStream(id, { start, end: end + 1 });
    downloadStream.pipe(res);
    downloadStream.on('error', (err) => {
      console.error('Syllabus stream error', err);
      res.status(500).end();
    });
    return;
  }

  if (fileSize > 0) {
    res.setHeader('Content-Length', fileSize);
  }

  const downloadStream = bucket.openDownloadStream(id);
  downloadStream.pipe(res);
  downloadStream.on('error', (err) => {
    console.error('Syllabus stream error', err);
    res.status(500).end();
  });
}

// helper: check roles
function adminOnly(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  next();
}

function teacherOrAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  if (req.user.role !== 'admin' && req.user.role !== 'teacher') {
    return res.status(403).json({ error: 'Teacher or admin only' });
  }
  next();
}

// Upload (teacher / admin)
router.post('/', auth, teacherOrAdmin, upload.single('file'), async (req, res) => {
  try {
    if (!bucket || !db) return res.status(503).json({ error: 'Storage not initialized yet' });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const file = req.file;

    // generate thumbnail buffer if image or pdf
    let thumbBuffer = null;
    try {
      if (file.mimetype.startsWith('image/')) {
        thumbBuffer = await sharp(file.buffer).resize(240).jpeg().toBuffer();
      } else if (file.mimetype === 'application/pdf') {
        // pdf-thumbnail returns a stream or buffer in some versions
        const t = await pdfThumbnail(file.buffer, { resize: { width: 240 } });
        // t can be a Buffer or Readable
        if (Buffer.isBuffer(t)) thumbBuffer = t;
        else {
          thumbBuffer = await streamToBuffer(t);
        }
      }
    } catch (thumbErr) {
      console.warn('Thumbnail generation failed', thumbErr);
    }

    // stream file buffer into GridFS
    const readStream = new stream.PassThrough();
    readStream.end(file.buffer);

    const uploadStream = bucket.openUploadStream(file.originalname, {
      contentType: file.mimetype,
      metadata: {
        ...await prepareMetadata(file, req.user, req.body),
        uploadedBy: req.user.email,
        role: req.user.role,
        originalname: file.originalname,
        hasThumb: !!thumbBuffer
      }
    });

    readStream.pipe(uploadStream)
      .on('error', (err) => {
        console.error('Upload error', err);
        return res.status(500).json({ error: 'Upload failed' });
      })
      .on('finish', async () => {
        // if thumbnail exists, store it in a separate bucket/object (we'll use a 'syllabus_thumbs' bucket)
        if (thumbBuffer) {
          const thumbStream = new stream.PassThrough();
          thumbStream.end(thumbBuffer);
          const thumbUpload = new GridFSBucket(db, { bucketName: 'syllabus_thumbs' })
            .openUploadStream(`${uploadStream.id.toString()}_thumb.jpg`, {
              contentType: 'image/jpeg',
              metadata: { parentFileId: uploadStream.id }
            });
          thumbStream.pipe(thumbUpload);
          // when thumb finishes, respond (we don't strictly need to wait, but we do for clarity)
          thumbUpload.on('finish', () => {
            return res.json({ id: uploadStream.id, filename: file.originalname });
          });
          thumbUpload.on('error', (e) => {
            console.warn('thumb upload err', e);
            return res.json({ id: uploadStream.id, filename: file.originalname });
          });
        } else {
          return res.json({ id: uploadStream.id, filename: file.originalname });
        }
      });
  } catch (e) {
    console.error('Upload route error', e);
    return res.status(500).json({ error: 'Server upload error' });
  }
});

// List files (public)
router.get('/', async (req, res) => {
  try {
    if (!db) return res.status(503).json({ error: 'Storage not initialized yet' });
    const files = await db.collection('syllabus_files.files').find(publicMaterials).sort({ uploadDate: -1 }).toArray();
    // normalize fields for frontend
    const list = files.map(f => ({
      _id: f._id,
      filename: f.filename,
      contentType: f.contentType,
      uploadDate: f.uploadDate,
      length: f.length,
      metadata: { subject: f.metadata?.subject, topic: f.metadata?.topic, textStatus: f.metadata?.textStatus }
    }));
    res.json(list);
  } catch (e) {
    console.error('List error', e);
    res.status(500).json({ error: 'Failed to list files' });
  }
});

// Preview / stream file inline (anyone)
router.get('/:id/preview', async (req, res) => {
  try {
    await streamFile(req, res, { forceDownload: false });
  } catch (e) {
    console.error('Preview error', e);
    res.status(500).json({ error: 'Preview failed' });
  }
});

// Download (force attachment)
router.get('/:id/download', async (req, res) => {
  try {
    await streamFile(req, res, { forceDownload: true });
  } catch (e) {
    console.error('Download error', e);
    res.status(500).json({ error: 'Download failed' });
  }
});

// Delete (admin only)
router.delete('/:id', auth, adminOnly, async (req, res) => {
  try {
    if (!bucket || !db) return res.status(503).json({ error: 'Storage not initialized yet' });
    const id = new ObjectId(req.params.id);
    await bucket.delete(id); // deletes file and chunks
    // also delete thumbnail if present
    await db.collection('syllabus_thumbs.files').deleteMany({ 'metadata.parentFileId': id });
    return res.json({ success: true });
  } catch (e) {
    console.error('Delete error', e);
    return res.status(500).json({ error: 'Delete failed' });
  }
});

module.exports = router;

// helper
function streamToBuffer(streamObj) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    streamObj.on('data', c => chunks.push(c));
    streamObj.on('end', () => resolve(Buffer.concat(chunks)));
    streamObj.on('error', reject);
  });
}
