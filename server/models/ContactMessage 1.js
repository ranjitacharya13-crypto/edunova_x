// server/models/ContactMessage.js
// SQL data-access layer for the `contact_messages` table (replaces the Mongoose model).
const { query } = require("../db");

const COLUMNS = `
  id,
  id AS "_id",
  name,
  email,
  message,
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

async function create({ name, email, message }) {
  const { rows } = await query(
    `INSERT INTO contact_messages (name, email, message)
     VALUES ($1, $2, $3)
     RETURNING ${COLUMNS}`,
    [name, email, message]
  );
  return rows[0];
}

async function count() {
  const { rows } = await query(`SELECT count(*)::int AS c FROM contact_messages`);
  return rows[0].c;
}

async function findRecent(limit = 4) {
  const { rows } = await query(
    `SELECT id, id AS "_id", name, email, created_at AS "createdAt"
     FROM contact_messages
     ORDER BY created_at DESC
     LIMIT $1`,
    [limit]
  );
  return rows;
}

async function list() {
  const { rows } = await query(
    `SELECT ${COLUMNS} FROM contact_messages ORDER BY created_at DESC`
  );
  return rows;
}

async function remove(id) {
  const result = await query(`DELETE FROM contact_messages WHERE id = $1`, [id]);
  return result.rowCount > 0;
}

module.exports = { create, count, findRecent, list, remove };
