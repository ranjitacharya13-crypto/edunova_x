// server/models/fileStore.js
// SQL file storage on Postgres `bytea` columns.
// Replaces the MongoDB GridFS buckets that were used for study/syllabus/assignment files.
const { query } = require("../db");

const FILE_TABLES = new Set([
  "study_files",
  "syllabus_files",
  "assignment_files",
]);

const THUMB_TABLES = new Set(["study_thumbs", "syllabus_thumbs"]);

function assertIn(name, allowed) {
  if (!allowed.has(name)) throw new Error(`Unknown file table: ${name}`);
}

async function saveFile(table, { filename, contentType, data, metadata = {} }) {
  assertIn(table, FILE_TABLES);
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data || []);
  const { rows } = await query(
    `INSERT INTO ${table} (filename, content_type, length, data, metadata)
     VALUES ($1, $2, $3, $4, $5::jsonb)
     RETURNING id::text AS id`,
    [
      filename,
      contentType || "application/octet-stream",
      buffer.length,
      buffer,
      JSON.stringify(metadata || {}),
    ]
  );
  return { id: rows[0].id, filename };
}

async function getFileMeta(table, id) {
  assertIn(table, FILE_TABLES);
  const { rows } = await query(
    `SELECT id::text AS id,
            id::text AS "_id",
            filename,
            content_type AS "contentType",
            length,
            metadata,
            created_at AS "uploadDate"
     FROM ${table}
     WHERE id = $1
     LIMIT 1`,
    [id]
  );
  if (!rows[0]) return null;
  return { ...rows[0], length: Number(rows[0].length || 0) };
}

async function getFileData(table, id) {
  assertIn(table, FILE_TABLES);
  const { rows } = await query(`SELECT data FROM ${table} WHERE id = $1 LIMIT 1`, [
    id,
  ]);
  return rows[0] ? rows[0].data : null;
}

// Byte range read for HTTP Range streaming.
// `start`/`end` are inclusive zero-based byte offsets, like HTTP Range requests.
async function getFileRange(table, id, start, end) {
  assertIn(table, FILE_TABLES);
  const size = end - start + 1;
  // substring on bytea is 1-based.
  const { rows } = await query(
    `SELECT substring(data FROM $2 FOR $3) AS chunk FROM ${table} WHERE id = $1`,
    [id, start + 1, size]
  );
  return rows[0] ? rows[0].chunk : null;
}

async function listFiles(table) {
  assertIn(table, FILE_TABLES);
  const { rows } = await query(
    `SELECT id::text AS id,
            id::text AS "_id",
            filename,
            content_type AS "contentType",
            length,
            metadata,
            created_at AS "uploadDate"
     FROM ${table}
     ORDER BY created_at DESC`
  );
  return rows.map((r) => ({ ...r, length: Number(r.length || 0) }));
}

async function deleteFile(table, id) {
  assertIn(table, FILE_TABLES);
  const result = await query(`DELETE FROM ${table} WHERE id = $1`, [id]);
  return result.rowCount > 0;
}

async function saveThumb(table, { parentFileId, data }) {
  assertIn(table, THUMB_TABLES);
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data || []);
  const { rows } = await query(
    `INSERT INTO ${table} (parent_file_id, filename, data)
     VALUES ($1, $2, $3)
     RETURNING id::text AS id`,
    [parentFileId, `${parentFileId}_thumb.jpg`, buffer]
  );
  return { id: rows[0].id };
}

async function deleteThumbsByParent(table, parentFileId) {
  assertIn(table, THUMB_TABLES);
  const result = await query(
    `DELETE FROM ${table} WHERE parent_file_id = $1`,
    [parentFileId]
  );
  return result.rowCount;
}

module.exports = {
  saveFile,
  getFileMeta,
  getFileData,
  getFileRange,
  listFiles,
  deleteFile,
  saveThumb,
  deleteThumbsByParent,
};
