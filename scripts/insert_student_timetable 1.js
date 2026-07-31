// scripts/insert_student_timetable.js
// Inserts student_timetable_with_times.json into the Postgres timetables
// table (the weekday grids are stored in the `days` jsonb column).
const { Pool } = require('pg');
const path = require('path');

async function main() {
  const uri = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL;
  if (!uri) {
    console.error('Please set DATABASE_URL (or SUPABASE_DB_URL) environment variable with your connection string.');
    process.exit(1);
  }

  const isLocal = /localhost|127\.0\.0\.1/i.test(uri);
  const pool = new Pool({
    connectionString: uri,
    ssl: isLocal ? false : { rejectUnauthorized: false },
  });

  try {
    const filePath = path.join(__dirname, '..', 'student_timetable_with_times.json');
    const doc = require(filePath);

    // Strip the Mongo "_id" export wrapper if present; keep only weekday grids.
    const { _id, ...days } = doc;

    const res = await pool.query(
      'INSERT INTO teacher_timetables (days) VALUES ($1::jsonb) RETURNING id',
      [JSON.stringify(days)]
    );
    console.log('Inserted row with id:', res.rows[0].id);
  } catch (err) {
    console.error('Insert failed:', err);
  } finally {
    await pool.end();
  }
}

main();
