-- ============================================================================
-- EduNova_X Postgres schema
-- Works on Postgres 13+ and Supabase. Fully idempotent (safe to re-run).
-- server/server.js auto-applies this file on boot; you can also run it
-- manually:  psql "$DATABASE_URL" -f schema.sql
-- ObjectId strings from MongoDB are replaced by UUID primary keys.
-- ============================================================================

-- ── Users ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text,
  dob         text,
  gender      text,
  username    text UNIQUE,
  email       text NOT NULL UNIQUE,
  password    text NOT NULL,
  role        text NOT NULL DEFAULT 'student'
              CHECK (role IN ('admin', 'teacher', 'student')),
  is_blocked  boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- ── Timetables (weekday -> [{ period, time, subject | class }] in `days`) ──
CREATE TABLE IF NOT EXISTS timetables (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  days        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS teacher_timetables (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  days        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- ── Live sessions ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS live_sessions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id        text NOT NULL,
  teacher_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  class_name     text NOT NULL,
  date           timestamptz NOT NULL,
  start_time     text NOT NULL DEFAULT '',
  end_time       text NOT NULL DEFAULT '',
  recording_url  text NOT NULL DEFAULT '',
  recording_path text NOT NULL DEFAULT '',
  assignment     jsonb NOT NULL DEFAULT '{"title":"","description":"","fileUrl":""}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS live_sessions_room_id_idx    ON live_sessions (room_id);
CREATE INDEX IF NOT EXISTS live_sessions_teacher_id_idx ON live_sessions (teacher_id);
CREATE INDEX IF NOT EXISTS live_sessions_date_idx       ON live_sessions (date);

-- ── Recordings ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS recordings (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title           text NOT NULL,
  room            text NOT NULL,
  teacher_id      uuid REFERENCES users(id) ON DELETE SET NULL,
  timetable_id    uuid,
  live_session_id uuid UNIQUE REFERENCES live_sessions(id) ON DELETE SET NULL,
  video_url       text NOT NULL,
  duration        double precision NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS recordings_room_idx ON recordings (room);

-- ── Assignment files (bytea replaces the GridFS "assignment_files" bucket) ─
CREATE TABLE IF NOT EXISTS assignment_files (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  filename     text NOT NULL,
  content_type text NOT NULL DEFAULT 'application/pdf',
  length       bigint NOT NULL DEFAULT 0,
  data         bytea NOT NULL,
  metadata     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- ── Assignments ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS assignments (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room       text NOT NULL,
  title      text NOT NULL,
  file_id    uuid REFERENCES assignment_files(id) ON DELETE SET NULL,
  filename   text NOT NULL,
  created_by jsonb NOT NULL DEFAULT '{}'::jsonb,
  quiz       jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS assignments_room_idx ON assignments (room);

-- ── Contact messages ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS contact_messages (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  email      text NOT NULL,
  message    text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ── Study materials (bytea replaces the GridFS "study_files" bucket) ───────
CREATE TABLE IF NOT EXISTS study_files (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  filename     text NOT NULL,
  content_type text NOT NULL DEFAULT 'application/octet-stream',
  length       bigint NOT NULL DEFAULT 0,
  data         bytea NOT NULL,
  metadata     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS study_thumbs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_file_id uuid NOT NULL REFERENCES study_files(id) ON DELETE CASCADE,
  filename       text NOT NULL,
  data           bytea NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS study_thumbs_parent_idx ON study_thumbs (parent_file_id);

-- ── Syllabus files (bytea replaces the GridFS "syllabus_files" bucket) ─────
CREATE TABLE IF NOT EXISTS syllabus_files (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  filename     text NOT NULL,
  content_type text NOT NULL DEFAULT 'application/octet-stream',
  length       bigint NOT NULL DEFAULT 0,
  data         bytea NOT NULL,
  metadata     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS syllabus_thumbs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_file_id uuid NOT NULL REFERENCES syllabus_files(id) ON DELETE CASCADE,
  filename       text NOT NULL,
  data           bytea NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS syllabus_thumbs_parent_idx ON syllabus_thumbs (parent_file_id);
