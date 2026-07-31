// connect.cjs — quick Postgres connectivity check (replaces the MongoDB version)
const { Pool } = require("pg");

async function main() {
  const uri = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL;
  if (!uri) {
    console.error("Please set DATABASE_URL (or SUPABASE_DB_URL) environment variable.");
    process.exit(1);
  }

  const isLocal = /localhost|127\.0\.0\.1/i.test(uri);
  const pool = new Pool({
    connectionString: uri,
    ssl: isLocal ? false : { rejectUnauthorized: false },
  });

  try {
    await pool.query("SELECT 1");
    console.log("edunova_x database connected");
  } catch (error) {
    console.error("❌ Postgres connection error:", error);
  } finally {
    await pool.end();
  }
}

main().catch(console.error);
