// server/models/Recording.js
// SQL data-access layer for the `recordings` table (replaces the Mongoose model).
const { query } = require("../db");

const COLUMNS = `
  id,
  id AS "_id",
  title,
  room,
  teacher_id AS "teacherId",
  timetable_id AS "timetableId",
  live_session_id AS "liveSessionId",
  video_url AS "videoUrl",
  duration,
  created_at AS "createdAt"
`;

// Replaces Mongoose's findOneAndUpdate({ liveSessionId }, doc, { upsert: true }).
async function upsertByLiveSession({
  title,
  room,
  teacherId,
  timetableId = null,
  liveSessionId,
  videoUrl,
  duration = 0,
}) {
  const { rows } = await query(
    `INSERT INTO recordings
       (title, room, teacher_id, timetable_id, live_session_id, video_url, duration, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now())
     ON CONFLICT (live_session_id) DO UPDATE SET
       title        = EXCLUDED.title,
       room         = EXCLUDED.room,
       teacher_id   = EXCLUDED.teacher_id,
       timetable_id = EXCLUDED.timetable_id,
       video_url    = EXCLUDED.video_url,
       duration     = EXCLUDED.duration,
       created_at   = EXCLUDED.created_at
     RETURNING ${COLUMNS}`,
    [title, room, teacherId, timetableId, liveSessionId, videoUrl, duration]
  );
  return rows[0];
}

async function count() {
  const { rows } = await query(`SELECT count(*)::int AS c FROM recordings`);
  return rows[0].c;
}

// Replaces Mongoose's `.populate("teacherId", "name email")`.
async function listWithTeacher() {
  const { rows } = await query(
    `SELECT
       r.id,
       r.id AS "_id",
       r.title,
       r.room,
       r.teacher_id AS "teacherId",
       r.timetable_id AS "timetableId",
       r.live_session_id AS "liveSessionId",
       r.video_url AS "videoUrl",
       r.duration,
       r.created_at AS "createdAt",
       u.name  AS "teacherName",
       u.email AS "teacherEmail"
     FROM recordings r
     LEFT JOIN users u ON u.id = r.teacher_id
     ORDER BY r.created_at DESC`
  );
  return rows;
}

async function remove(id) {
  const result = await query(`DELETE FROM recordings WHERE id = $1`, [id]);
  return result.rowCount > 0;
}

module.exports = { upsertByLiveSession, count, listWithTeacher, remove };
