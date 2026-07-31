// server/models/Assignment.js
// SQL data-access layer for the `assignments` table (replaces the Mongoose model).
// The PDF bytes live in `assignment_files` (see models/fileStore.js) instead of GridFS.
const { query } = require("../db");

const COLUMNS = `
  id,
  id AS "_id",
  room,
  title,
  file_id AS "fileId",
  filename,
  created_by AS "createdBy",
  quiz,
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

async function create({ room, title, fileId, filename, createdBy, quiz = [] }) {
  const { rows } = await query(
    `INSERT INTO assignments (room, title, file_id, filename, created_by, quiz)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)
     RETURNING ${COLUMNS}`,
    [room, title, fileId, filename, JSON.stringify(createdBy || {}), JSON.stringify(quiz)]
  );
  return rows[0];
}

async function findById(id) {
  const { rows } = await query(
    `SELECT ${COLUMNS} FROM assignments WHERE id = $1 LIMIT 1`,
    [id]
  );
  return rows[0] || null;
}

async function list(room) {
  if (room) {
    const { rows } = await query(
      `SELECT ${COLUMNS} FROM assignments WHERE room = $1 ORDER BY created_at DESC`,
      [room]
    );
    return rows;
  }
  const { rows } = await query(
    `SELECT ${COLUMNS} FROM assignments ORDER BY created_at DESC`
  );
  return rows;
}

async function count() {
  const { rows } = await query(`SELECT count(*)::int AS c FROM assignments`);
  return rows[0].c;
}

async function findRecent(limit = 4) {
  const { rows } = await query(
    `SELECT id, id AS "_id", title, room, created_at AS "createdAt"
     FROM assignments
     ORDER BY created_at DESC
     LIMIT $1`,
    [limit]
  );
  return rows;
}

module.exports = { create, findById, list, count, findRecent };
