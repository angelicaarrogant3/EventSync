const fs = require('fs');
const path = require('path');
const config = require('../config');

const isPostgres = Boolean(config.databaseUrl);

let db = null;
let pool = null;

/**
 * Convert SQLite-style `?` placeholders to PostgreSQL `$1, $2, ...`
 * while skipping `?` inside single-quoted string literals.
 */
function toPgParamsSql(sql) {
  let index = 0;
  let inSingleQuote = false;
  let out = '';

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'") {
      if (inSingleQuote && sql[i + 1] === "'") {
        out += "''";
        i++;
        continue;
      }
      inSingleQuote = !inSingleQuote;
      out += ch;
      continue;
    }
    if (ch === '?' && !inSingleQuote) {
      index += 1;
      out += `$${index}`;
      continue;
    }
    out += ch;
  }
  return out;
}

if (isPostgres) {
  const { Pool } = require('pg');
  const isLocalPg = /localhost|127\.0\.0\.1/.test(config.databaseUrl);
  pool = new Pool({
    connectionString: config.databaseUrl,
    ssl: isLocalPg ? false : { rejectUnauthorized: false },
    max: 10
  });
} else {
  const Database = require('better-sqlite3');
  const dbDir = path.dirname(config.dbPath);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }
  db = new Database(config.dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');
}

function makeExecutor(pgClient = null) {
  if (isPostgres) {
    const runner = pgClient || pool;
    return {
      isPostgres: true,
      async get(sql, params = []) {
        const res = await runner.query(toPgParamsSql(sql), params);
        return res.rows[0];
      },
      async all(sql, params = []) {
        const res = await runner.query(toPgParamsSql(sql), params);
        return res.rows;
      },
      async run(sql, params = []) {
        const res = await runner.query(toPgParamsSql(sql), params);
        return { changes: res.rowCount || 0, lastInsertRowid: null };
      }
    };
  }

  return {
    isPostgres: false,
    async get(sql, params = []) {
      return db.prepare(sql).get(...params);
    },
    async all(sql, params = []) {
      return db.prepare(sql).all(...params);
    },
    async run(sql, params = []) {
      const info = db.prepare(sql).run(...params);
      return { changes: info.changes, lastInsertRowid: info.lastInsertRowid };
    }
  };
}

const baseExec = makeExecutor();

const query = {
  isPostgres,
  get: baseExec.get,
  all: baseExec.all,
  run: baseExec.run,
  async transaction(fn) {
    if (isPostgres) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const tx = makeExecutor(client);
        const result = await fn(tx);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    }

    db.exec('BEGIN IMMEDIATE');
    try {
      const result = await fn(baseExec);
      db.exec('COMMIT');
      return result;
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // Ignore rollback error if already rolled back
      }
      throw err;
    }
  }
};

function hasColumn(tableName, columnName) {
  const cols = db.prepare(`PRAGMA table_info(${tableName})`).all();
  return cols.some((c) => c.name === columnName);
}

function runSafeMigrations() {
  if (!hasColumn('node_status', 'device_type')) {
    db.exec(`ALTER TABLE node_status ADD COLUMN device_type TEXT NOT NULL DEFAULT 'laptop'`);
    console.log('[DB] Migrated node_status: added device_type');
  }
  if (!hasColumn('node_status', 'device_name')) {
    db.exec(`ALTER TABLE node_status ADD COLUMN device_name TEXT NOT NULL DEFAULT 'Device'`);
    console.log('[DB] Migrated node_status: added device_name');
  }

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

  if (!hasColumn('participants', 'user_id')) {
    db.exec(`ALTER TABLE participants ADD COLUMN user_id TEXT REFERENCES users(id) ON DELETE SET NULL`);
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_participants_user_id_uq ON participants(user_id) WHERE user_id IS NOT NULL`);
    console.log('[DB] Migrated participants: added user_id');
  }
  if (!hasColumn('participants', 'contact_number')) {
    db.exec(`ALTER TABLE participants ADD COLUMN contact_number TEXT DEFAULT ''`);
    console.log('[DB] Migrated participants: added contact_number');
  }

  if (!hasColumn('registrations', 'registered_by_user_id')) {
    db.exec(`ALTER TABLE registrations ADD COLUMN registered_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL`);
    console.log('[DB] Migrated registrations: added registered_by_user_id');
  }
  if (!hasColumn('registrations', 'token_version')) {
    db.exec(`ALTER TABLE registrations ADD COLUMN token_version INTEGER NOT NULL DEFAULT 1`);
    console.log('[DB] Migrated registrations: added token_version');
  }

  if (!hasColumn('attendance', 'verified_by_user_id')) {
    db.exec(`ALTER TABLE attendance ADD COLUMN verified_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL`);
    console.log('[DB] Migrated attendance: added verified_by_user_id');
  }
}

async function initializeDatabase() {
  if (isPostgres) {
    const schemaPath = path.join(__dirname, 'schema.postgres.sql');
    const schemaSql = fs.readFileSync(schemaPath, 'utf8');
    await pool.query(schemaSql);
  } else {
    const schemaPath = path.join(__dirname, 'schema.sql');
    const schemaSql = fs.readFileSync(schemaPath, 'utf8');
    db.exec(schemaSql);
    try {
      runSafeMigrations();
    } catch (migErr) {
      console.warn('[DB] Migration warning:', migErr.message);
    }
  }

  const nowIso = new Date().toISOString();
  const defaultNodes = [
    ['node-1', 'SERVER', 'server', 'Laptop 1 (Central Server)', nowIso, 'ONLINE', '127.0.0.1'],
    ['node-2', 'REGISTRATION', 'laptop', 'Registration Station (Default)', nowIso, 'OFFLINE', 'pending'],
    ['node-3', 'SCANNER', 'phone', 'Scanner Station (Default)', nowIso, 'OFFLINE', 'pending'],
    ['node-4', 'ORGANIZER', 'tablet', 'Organizer Console (Default)', nowIso, 'OFFLINE', 'pending']
  ];

  await query.transaction(async (tx) => {
    for (const node of defaultNodes) {
      await tx.run(
        `INSERT INTO node_status (node_id, role, device_type, device_name, last_seen, status, ip_address)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(node_id) DO UPDATE SET
           role = excluded.role,
           device_type = COALESCE(excluded.device_type, node_status.device_type),
           device_name = COALESCE(excluded.device_name, node_status.device_name)`,
        node
      );
    }
  });

  if (isPostgres) {
    console.log('[DB] Connected to Supabase PostgreSQL.');
  } else {
    console.log('[DB] SQLite database initialized in WAL mode at:', config.dbPath);
  }
}

async function closeDatabase() {
  if (pool) {
    await pool.end();
  } else if (db) {
    db.close();
  }
}

module.exports = {
  db,
  query,
  isPostgres,
  initializeDatabase,
  closeDatabase
};
