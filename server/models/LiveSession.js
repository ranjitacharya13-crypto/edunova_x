// server/models/LiveSession.js
// SQL data-access layer for the `live_sessions` table (replaces the Mongoose model).
const { query } = require("../db");

// Aliases keep the API response shape identical to the old Mongoose docs
// (camelCase: roomId, teacherId, className, endTime, recordingUrl, ...).
const COLUMNS = `
  id,
  id AS "_id",
  room_id AS "roomId",
  teacher_id AS "teacherId",
  class_name AS "className",
  date,
  start_time AS "startTime",
  end_time AS "endTime",
  recording_url AS "recordingUrl",
  recording_path AS "recordingPath",
  assignment,
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

const DEFAULT_ASSIGNMENT = { title: "", description: "", fileUrl: "" };

async function findById(id) {
  const { rows } = await query(
    `SELECT ${COLUMNS} FROM live_sessions WHERE id = $1 LIMIT 1`,
    [id]
  );
  return rows[0] || null;
}

async function findTodayByRoomAndTeacher({ roomId, teacherId, start, end }) {
  const { rows } = await query(
    `SELECT ${COLUMNS} FROM live_sessions
     WHERE room_id = $1 AND teacher_id = $2 AND date >= $3 AND date < $4
     ORDER BY created_at DESC
     LIMIT 1`,
    [roomId, teacherId, start, end]
  );
  return rows[0] || null;
}

async function create({
  roomId,
  teacherId,
  className,
  date,
  startTime = "",
  endTime = "",
  recordingUrl = "",
  recordingPath = "",
  assignment = DEFAULT_ASSIGNMENT,
}) {
  const { rows } = await query(
    `INSERT INTO live_sessions
       (room_id, teacher_id, class_name, date, start_time, end_time,
        recording_url, recording_path, assignment)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
     RETURNING ${COLUMNS}`,
    [
      roomId,
      teacherId,
      className,
      date,
      startTime,
      endTime,
      recordingUrl,
      recordingPath,
      JSON.stringify(assignment || DEFAULT_ASSIGNMENT),
    ]
  );
  return rows[0];
}

async function updateAssignment(id, assignment) {
  const { rows } = await query(
    `UPDATE live_sessions
     SET assignment = $2::jsonb, updated_at = now()
     WHERE id = $1
     RETURNING ${COLUMNS}`,
    [id, JSON.stringify(assignment || DEFAULT_ASSIGNMENT)]
  );
  return rows[0] || null;
}

async function finish(id, { endTime, recordingUrl, recordingPath }) {
  const { rows } = await query(
    `UPDATE live_sessions
     SET end_time = $2,
         recording_url = $3,
         recording_path = $4,
         updated_at = now()
     WHERE id = $1
     RETURNING ${COLUMNS}`,
    [id, endTime || "", recordingUrl || "", recordingPath || ""]
  );
  return rows[0] || null;
}

async function listToday({ start, end, rooms = [] }) {
  const params = [start, end];
  let sql = `SELECT ${COLUMNS} FROM live_sessions
             WHERE date >= $1 AND date < $2`;
  if (rooms.length) {
    params.push(rooms);
    sql += ` AND room_id = ANY($3::text[])`;
  }
  sql += ` ORDER BY created_at ASC`;
  const { rows } = await query(sql, params);
  return rows;
}

async function count() {
  const { rows } = await query(`SELECT count(*)::int AS c FROM live_sessions`);
  return rows[0].c;
}

async function findRecent(limit = 4) {
  const { rows } = await query(
    `SELECT id, id AS "_id", room_id AS "roomId", class_name AS "className",
            created_at AS "createdAt"
     FROM live_sessions
     ORDER BY created_at DESC
     LIMIT $1`,
    [limit]
  );
  return rows;
}

// Replaces Mongoose's `.populate("teacherId", "name email")`.
async function listWithTeacher() {
  const { rows } = await query(
    `SELECT
       l.id,
       l.id AS "_id",
       l.room_id AS "roomId",
       l.teacher_id AS "teacherId",
       l.class_name AS "className",
       l.date,
       l.start_time AS "startTime",
       l.end_time AS "endTime",
       l.recording_url AS "recordingUrl",
       l.recording_path AS "recordingPath",
       l.assignment,
       l.created_at AS "createdAt",
       u.name  AS "teacherName",
       u.email AS "teacherEmail"
     FROM live_sessions l
     LEFT JOIN users u ON u.id = l.teacher_id
     ORDER BY l.created_at DESC`
  );
  return rows;
}

async function createdAts() {
  const { rows } = await query(
    `SELECT id, id AS "_id", created_at AS "createdAt" FROM live_sessions`
  );
  return rows;
}

module.exports = {
  findById,
  findTodayByRoomAndTeacher,
  create,
  updateAssignment,
  finish,
  listToday,
  count,
  findRecent,
  listWithTeacher,
  createdAts,
};
