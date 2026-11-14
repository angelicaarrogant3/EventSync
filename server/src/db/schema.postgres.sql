-- EventSync Database Schema (PostgreSQL / Supabase)
-- Authoritative Single Source of Truth

-- 0. Users Table (Application Accounts: administrator | participant)
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  full_name TEXT NOT NULL,
  username TEXT UNIQUE NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('administrator', 'participant')),
  account_status TEXT NOT NULL CHECK(account_status IN ('active', 'inactive')) DEFAULT 'active',
  must_change_password INTEGER NOT NULL DEFAULT 0 CHECK(must_change_password IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP::text)
);

-- 0b. Server-Side Sessions Table
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at BIGINT NOT NULL,
  last_activity_at BIGINT NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP::text)
);

-- 1. Events Table
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  category TEXT NOT NULL DEFAULT 'General',
  venue TEXT NOT NULL,
  event_date TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  registration_deadline TEXT,
  capacity INTEGER NOT NULL CHECK(capacity > 0),
  status TEXT NOT NULL CHECK(status IN ('DRAFT', 'OPEN', 'ONGOING', 'COMPLETED', 'CANCELLED', 'CLOSED', 'ENDED')) DEFAULT 'DRAFT',
  archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP::text)
);

-- 2. Participants Table
CREATE TABLE IF NOT EXISTS participants (
  id TEXT PRIMARY KEY,
  user_id TEXT UNIQUE REFERENCES users(id) ON DELETE SET NULL,
  school_id TEXT UNIQUE NOT NULL,
  full_name TEXT NOT NULL,
  email TEXT NOT NULL,
  contact_number TEXT DEFAULT '',
  department_or_course TEXT NOT NULL,
  year_level TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('STUDENT', 'FACULTY', 'STAFF')) DEFAULT 'STUDENT',
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP::text)
);

-- 3. Registrations Table
CREATE TABLE IF NOT EXISTS registrations (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  qr_token TEXT NOT NULL,
  token_version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL CHECK(status IN ('REGISTERED', 'CANCELLED')) DEFAULT 'REGISTERED',
  registered_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP::text),
  registered_by_node TEXT NOT NULL DEFAULT 'SYSTEM',
  registered_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT uq_event_participant UNIQUE (event_id, participant_id)
);

-- 4. Attendance Table
CREATE TABLE IF NOT EXISTS attendance (
  id TEXT PRIMARY KEY,
  registration_id TEXT UNIQUE NOT NULL REFERENCES registrations(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  checked_in_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP::text),
  scanned_by_node TEXT NOT NULL DEFAULT 'SYSTEM',
  verified_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  client_scan_id TEXT UNIQUE NOT NULL,
  was_offline_sync INTEGER NOT NULL DEFAULT 0 CHECK(was_offline_sync IN (0, 1)),
  CONSTRAINT uq_attendance_registration UNIQUE (registration_id),
  CONSTRAINT uq_attendance_client_scan UNIQUE (client_scan_id)
);

-- 5. Node / Device Status Table
CREATE TABLE IF NOT EXISTS node_status (
  node_id TEXT PRIMARY KEY,
  role TEXT NOT NULL,
  device_type TEXT NOT NULL DEFAULT 'laptop',
  device_name TEXT NOT NULL DEFAULT 'Device',
  last_seen TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP::text),
  status TEXT NOT NULL CHECK(status IN ('ONLINE', 'OFFLINE')) DEFAULT 'OFFLINE',
  ip_address TEXT DEFAULT '127.0.0.1'
);

-- 6. Audit Log Table
CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  node_id TEXT NOT NULL DEFAULT 'SYSTEM',
  timestamp TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP::text),
  details_json TEXT
);

-- 7. Activity Logs Table
CREATE TABLE IF NOT EXISTS activity_logs (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  description TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP::text)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_registrations_event ON registrations(event_id, status);
CREATE INDEX IF NOT EXISTS idx_registrations_participant ON registrations(participant_id);
CREATE INDEX IF NOT EXISTS idx_attendance_event ON attendance(event_id);
CREATE INDEX IF NOT EXISTS idx_attendance_registration ON attendance(registration_id);
CREATE INDEX IF NOT EXISTS idx_participants_school_id ON participants(school_id);
CREATE INDEX IF NOT EXISTS idx_node_status_role ON node_status(role, status);
CREATE INDEX IF NOT EXISTS idx_activity_logs_created ON activity_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_logs_user ON activity_logs(user_id);
