// server/db.js
// Postgres (Supabase / Render / local) connection pool.
// Replaces the old Mongoose/MongoDB connection.
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });
const { Pool } = require("pg");

const connectionString =
  process.env.DATABASE_URL ||
  process.env.SUPABASE_DB_URL ||
  process.env.POSTGRES_URL ||
  "";

if (!connectionString) {
  console.warn(
    "⚠️  DATABASE_URL is not set — Postgres queries will fail until it is configured."
  );
}

const isLocal = /localhost|127\.0\.0\.1/i.test(connectionString);

function buildSsl() {
  const flag = String(process.env.DATABASE_SSL || "").toLowerCase();
  if (flag === "false" || flag === "disable") return false;
  if (flag === "true" || flag === "require") return { rejectUnauthorized: false };
  // Local Postgres normally runs without SSL; managed Postgres (Supabase,
  // Render, Neon, ...) requires it.
  if (isLocal || !connectionString) return false;
  return { rejectUnauthorized: false };
}

const pool = new Pool({
  connectionString,
  ssl: buildSsl(),
  max: Number(process.env.PG_POOL_MAX || 10),
});

pool.on("error", (err) => {
  console.error("Unexpected Postgres pool error:", err);
});

function query(text, params) {
  return pool.query(text, params);
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value) {
  return UUID_RE.test(String(value || ""));
}

module.exports = { pool, query, isUuid };
