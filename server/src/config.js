const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dotenv = require('dotenv');

const rootDir = path.resolve(__dirname, '../..');
const rootEnvPath = path.join(rootDir, '.env');
const serverEnvPath = path.resolve(__dirname, '../.env');
const defaultDataDir = path.join(rootDir, 'data');

/**
 * On first run, ensure data directory exists and create a local .env
 * with randomly generated secrets if no .env exists yet.
 */
function ensureFirstRunSetup() {
  if (!fs.existsSync(defaultDataDir)) {
    fs.mkdirSync(defaultDataDir, { recursive: true });
  }

  if (!fs.existsSync(rootEnvPath) && !fs.existsSync(serverEnvPath)) {
    const sessionSecret = crypto.randomBytes(32).toString('hex');
    const qrHmacSecret = crypto.randomBytes(32).toString('hex');
    const initialEnv = [
      '# EventSync Local Environment (auto-generated on first run — do not commit)',
      'PORT=3000',
      'HOST=0.0.0.0',
      'HTTPS=false',
      'HTTP_ONLY=false',
      '# SERVER_HOST=192.168.1.14',
      'DB_PATH=./data/eventsync.db',
      `SESSION_SECRET=${sessionSecret}`,
      'SESSION_TIMEOUT_MINUTES=120',
      `QR_HMAC_SECRET=${qrHmacSecret}`,
      'NODE_ID=node-1',
      'NODE_ROLE=SERVER',
      'HEARTBEAT_TIMEOUT_MS=15000',
      'CORS_ORIGIN=*',
      ''
    ].join('\n');

    fs.writeFileSync(rootEnvPath, initialEnv, { encoding: 'utf8', mode: 0o600 });
    console.log('[Config] Created local .env with freshly generated secrets.');
  }
}

ensureFirstRunSetup();

// Load .env from project root first, then server directory (shell env vars take highest precedence)
if (fs.existsSync(rootEnvPath)) {
  dotenv.config({ path: rootEnvPath });
}
if (fs.existsSync(serverEnvPath)) {
  dotenv.config({ path: serverEnvPath });
}

function getRequiredSecret(envKey) {
  if (process.env[envKey] && process.env[envKey].trim().length >= 16) {
    return process.env[envKey].trim();
  }
  // Ephemeral fallback only for unconfigured test/CI runs — never a hard-coded string
  return crypto.randomBytes(32).toString('hex');
}

const useHttps = process.env.HTTPS === 'true' && process.env.HTTP_ONLY !== 'true';

const config = {
  rootDir,
  port: parseInt(process.env.PORT || '3000', 10),
  host: process.env.HOST || '0.0.0.0',
  serverHost: process.env.SERVER_HOST || null,
  useHttps,
  databaseUrl: (process.env.DATABASE_URL || '').trim(),
  dbPath: path.resolve(rootDir, process.env.DB_PATH || 'data/eventsync.db'),
  sessionSecret: getRequiredSecret('SESSION_SECRET'),
  sessionTimeoutMinutes: parseInt(process.env.SESSION_TIMEOUT_MINUTES || '120', 10),
  qrHmacSecret: getRequiredSecret('QR_HMAC_SECRET'),
  nodeId: process.env.NODE_ID || 'node-1',
  nodeRole: process.env.NODE_ROLE || 'SERVER',
  heartbeatTimeoutMs: parseInt(process.env.HEARTBEAT_TIMEOUT_MS || '15000', 10),
  corsOrigin: process.env.CORS_ORIGIN || '*'
};

module.exports = config;
