const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('../config');

// Ensure database directory exists
const dbDir = path.dirname(config.dbPath);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

// Open SQLite database connection
const db = new Database(config.dbPath);

// Distributed Systems PRAGMAs: WAL mode, foreign keys, busy timeout
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');
db.pragma('synchronous = NORMAL');

/**
 * Helper to check if a column exists on a table
 */
function hasColumn(tableName, columnName) {
  const cols = db.prepare(`PRAGMA table_info(${tableName})`).all();
  return cols.some(c => c.name === columnName);
}

/**
 * Safely migrate existing tables without losing any data
 */
function runSafeMigrations() {
  // 1. node_status columns
  if (!hasColumn('node_status', 'device_type')) {
    db.exec(`ALTER TABLE node_status ADD COLUMN device_type TEXT NOT NULL DEFAULT 'laptop'`);
    console.log('[DB] Migrated node_status: added device_type');
  }
  if (!hasColumn('node_status', 'device_name')) {
    db.exec(`ALTER TABLE node_status ADD COLUMN device_name TEXT NOT NULL DEFAULT 'Device'`);
    console.log('[DB] Migrated node_status: added device_name');
  }

  // 2. events columns & expanded status CHECK constraint
  if (!hasColumn('events', 'archived')) {
    db.exec(`ALTER TABLE events ADD COLUMN archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0, 1))`);
    console.log('[DB] Migrated events: added archived');
  }
  if (!hasColumn('events', 'category')) {
    db.exec(`ALTER TABLE events ADD COLUMN category TEXT NOT NULL DEFAULT 'General'`);
    console.log('[DB] Migrated events: added category');
  }
  if (!hasColumn('events', 'registration_deadline')) {
    db.exec(`ALTER TABLE events ADD COLUMN registration_deadline TEXT`);
    console.log('[DB] Migrated events: added registration_deadline');
  }

  // Check if events table CHECK constraint needs expansion for ONGOING/COMPLETED/CANCELLED
  const evSqlRow = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='events'`).get();
  if (evSqlRow && evSqlRow.sql && !evSqlRow.sql.includes("'CANCELLED'")) {
    console.log('[DB] Migrating events table CHECK constraint to support ONGOING, COMPLETED, CANCELLED...');
    db.pragma('foreign_keys = OFF');
    const migrateEventsTx = db.transaction(() => {
      db.exec(`
        CREATE TABLE events_new (
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
          created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
        );
        INSERT INTO events_new (id, title, description, category, venue, event_date, start_time, end_time, registration_deadline, capacity, status, archived, created_at)
        SELECT id, title, description, COALESCE(category, 'General'), venue, event_date, start_time, end_time, registration_deadline, capacity, status, COALESCE(archived, 0), created_at FROM events;
        DROP TABLE events;
        ALTER TABLE events_new RENAME TO events;
      `);
    });
    migrateEventsTx();
    db.pragma('foreign_keys = ON');
    console.log('[DB] Migrated events table successfully (all rows preserved).');
  }

  // 3. participants columns
  if (!hasColumn('participants', 'user_id')) {
    db.exec(`ALTER TABLE participants ADD COLUMN user_id TEXT REFERENCES users(id) ON DELETE SET NULL`);
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_participants_user_id_uq ON participants(user_id) WHERE user_id IS NOT NULL`);
    console.log('[DB] Migrated participants: added user_id');
  }
  if (!hasColumn('participants', 'contact_number')) {
    db.exec(`ALTER TABLE participants ADD COLUMN contact_number TEXT DEFAULT ''`);
    console.log('[DB] Migrated participants: added contact_number');
  }

  // 4. registrations columns
  if (!hasColumn('registrations', 'registered_by_user_id')) {
    db.exec(`ALTER TABLE registrations ADD COLUMN registered_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL`);
    console.log('[DB] Migrated registrations: added registered_by_user_id');
  }
  if (!hasColumn('registrations', 'token_version')) {
    db.exec(`ALTER TABLE registrations ADD COLUMN token_version INTEGER NOT NULL DEFAULT 1`);
    console.log('[DB] Migrated registrations: added token_version');
  }

  // 5. attendance columns
  if (!hasColumn('attendance', 'verified_by_user_id')) {
    db.exec(`ALTER TABLE attendance ADD COLUMN verified_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL`);
    console.log('[DB] Migrated attendance: added verified_by_user_id');
  }
}

/**
 * Initialize schema and apply non-destructive migrations
 */
function initializeDatabase() {
  const schemaPath = path.join(__dirname, 'schema.sql');
  const schemaSql = fs.readFileSync(schemaPath, 'utf8');

  // Execute DDL script
  db.exec(schemaSql);

  try {
    runSafeMigrations();
  } catch (migErr) {
    console.warn('[DB] Migration warning:', migErr.message);
  }

  // Pre-register cluster nodes in node_status table for initial discovery
  const defaultNodes = [
    { nodeId: 'node-1', role: 'SERVER', deviceType: 'server', deviceName: 'Laptop 1 (Central Server)', status: 'ONLINE', ip: '127.0.0.1' },
    { nodeId: 'node-2', role: 'REGISTRATION', deviceType: 'laptop', deviceName: 'Registration Station (Default)', status: 'OFFLINE', ip: 'pending' },
    { nodeId: 'node-3', role: 'SCANNER', deviceType: 'phone', deviceName: 'Scanner Station (Default)', status: 'OFFLINE', ip: 'pending' },
    { nodeId: 'node-4', role: 'ORGANIZER', deviceType: 'tablet', deviceName: 'Organizer Console (Default)', status: 'OFFLINE', ip: 'pending' }
  ];

  const insertNode = db.prepare(`
    INSERT INTO node_status (node_id, role, device_type, device_name, last_seen, status, ip_address)
    VALUES (@nodeId, @role, @deviceType, @deviceName, datetime('now', 'localtime'), @status, @ip)
    ON CONFLICT(node_id) DO UPDATE SET
      role = excluded.role,
      device_type = COALESCE(excluded.device_type, node_status.device_type),
      device_name = COALESCE(excluded.device_name, node_status.device_name)
  `);

  const initClusterTx = db.transaction((nodes) => {
    for (const node of nodes) {
      insertNode.run(node);
    }
  });

  initClusterTx(defaultNodes);
  console.log('[DB] SQLite database initialized in WAL mode at:', config.dbPath);
}

module.exports = {
  db,
  initializeDatabase
};
