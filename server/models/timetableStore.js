// server/models/timetableStore.js
// Shared SQL data-access factory for `timetables` / `teacher_timetables`.
// The weekday grids (Monday..Friday) live in a single `days` jsonb column,
// replacing the embedded Mongoose subdocument arrays.
const { query } = require("../db");

function assertTable(table) {
  if (table !== "timetables" && table !== "teacher_timetables") {
    throw new Error(`Unknown timetable table: ${table}`);
  }
}

// Shape returned to callers mirrors the old Mongoose documents:
// { _id, id, createdAt, updatedAt, Monday: [...], Tuesday: [...], ... }
function rowToDoc(row) {
  if (!row) return null;
  const days = row.days && typeof row.days === "object" ? row.days : {};
  return {
    _id: row.id,
    id: row.id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...days,
  };
}

module.exports = function timetableStore(table) {
  assertTable(table);

  async function findFirst() {
    const { rows } = await query(
      `SELECT id, days, created_at, updated_at FROM ${table}
       ORDER BY created_at ASC
       LIMIT 1`
    );
    return rowToDoc(rows[0]);
  }

  async function findById(id) {
    const { rows } = await query(
      `SELECT id, days, created_at, updated_at FROM ${table} WHERE id = $1 LIMIT 1`,
      [id]
    );
    return rowToDoc(rows[0]);
  }

  async function list() {
    const { rows } = await query(
      `SELECT id, days, created_at, updated_at FROM ${table}
       ORDER BY created_at DESC`
    );
    return rows.map(rowToDoc);
  }

  async function count() {
    const { rows } = await query(`SELECT count(*)::int AS c FROM ${table}`);
    return rows[0].c;
  }

  async function create(days) {
    const { rows } = await query(
      `INSERT INTO ${table} (days) VALUES ($1::jsonb)
       RETURNING id, days, created_at, updated_at`,
      [JSON.stringify(days || {})]
    );
    return rowToDoc(rows[0]);
  }

  async function remove(id) {
    const result = await query(`DELETE FROM ${table} WHERE id = $1`, [id]);
    return result.rowCount > 0;
  }

  return { findFirst, findById, list, count, create, remove };
};
