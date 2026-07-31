// server/models/User.js
// SQL data-access layer for the `users` table (replaces the Mongoose model).
const { query } = require("../db");

const BASE_COLUMNS = `
  id,
  id AS "_id",
  name,
  dob,
  gender,
  username,
  email,
  role,
  is_blocked AS "isBlocked",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

async function findById(id, { includePassword = false } = {}) {
  const cols = includePassword ? `${BASE_COLUMNS}, password` : BASE_COLUMNS;
  const { rows } = await query(
    `SELECT ${cols} FROM users WHERE id = $1 LIMIT 1`,
    [id]
  );
  return rows[0] || null;
}

async function findByEmail(email, { includePassword = false } = {}) {
  const cols = includePassword ? `${BASE_COLUMNS}, password` : BASE_COLUMNS;
  const { rows } = await query(
    `SELECT ${cols} FROM users WHERE email = $1 LIMIT 1`,
    [email]
  );
  return rows[0] || null;
}

async function findByEmailOrUsername(email, username) {
  const { rows } = await query(
    `SELECT ${BASE_COLUMNS} FROM users WHERE email = $1 OR username = $2 LIMIT 1`,
    [email, username]
  );
  return rows[0] || null;
}

async function create({ name, dob, gender, username, email, password, role = "student" }) {
  const { rows } = await query(
    `INSERT INTO users (name, dob, gender, username, email, password, role)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING ${BASE_COLUMNS}`,
    [name || null, dob || null, gender || null, username || null, email, password, role]
  );
  return rows[0];
}

async function count(role) {
  if (role) {
    const { rows } = await query(
      `SELECT count(*)::int AS c FROM users WHERE role = $1`,
      [role]
    );
    return rows[0].c;
  }
  const { rows } = await query(`SELECT count(*)::int AS c FROM users`);
  return rows[0].c;
}

async function list(role) {
  if (role) {
    const { rows } = await query(
      `SELECT ${BASE_COLUMNS} FROM users WHERE role = $1
       ORDER BY created_at DESC, name ASC`,
      [role]
    );
    return rows;
  }
  const { rows } = await query(
    `SELECT ${BASE_COLUMNS} FROM users ORDER BY created_at DESC, name ASC`
  );
  return rows;
}

async function setBlocked(id, blocked) {
  const { rows } = await query(
    `UPDATE users SET is_blocked = $2, updated_at = now()
     WHERE id = $1
     RETURNING ${BASE_COLUMNS}`,
    [id, Boolean(blocked)]
  );
  return rows[0] || null;
}

async function setRoleByEmail(email, role) {
  const { rows } = await query(
    `UPDATE users SET role = $2, updated_at = now()
     WHERE email = $1
     RETURNING ${BASE_COLUMNS}`,
    [email, role]
  );
  return rows[0] || null;
}

async function remove(id) {
  const result = await query(`DELETE FROM users WHERE id = $1`, [id]);
  return result.rowCount > 0;
}

async function createdAts(role) {
  if (role) {
    const { rows } = await query(
      `SELECT id, id AS "_id", created_at AS "createdAt" FROM users WHERE role = $1`,
      [role]
    );
    return rows;
  }
  const { rows } = await query(
    `SELECT id, id AS "_id", created_at AS "createdAt" FROM users`
  );
  return rows;
}

module.exports = {
  findById,
  findByEmail,
  findByEmailOrUsername,
  create,
  count,
  list,
  setBlocked,
  setRoleByEmail,
  remove,
  createdAts,
};
