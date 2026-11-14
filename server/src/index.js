const http = require('http');
const https = require('https');
const QRCode = require('qrcode');
const app = require('./app');
const config = require('./config');
const { initializeDatabase, getDb } = require('./db/connection');
const { initializeSockets } = require('./sockets/socketManager');
const {
  buildStartupLinks,
  formatStartupBanner,
  copyToClipboard,
  getFirewallHint
} = require('./utils/network');
const { getOrGenerateCertificates } = require('./utils/cert');

const args = new Set(process.argv.slice(2));
const showInfo = args.has('--info') || process.env.START_INFO === 'true';
const showQr = args.has('--qr') || process.env.START_QR === 'true';

// Initialize authoritative SQLite database in WAL mode
initializeDatabase();

let server;
let protocol = 'http';

if (config.useHttps) {
  try {
    const { key, cert } = getOrGenerateCertificates();
    server = https.createServer({ key, cert }, app);
    protocol = 'https';
  } catch (sslErr) {
    console.error('[Server] SSL initialization failed, falling back to HTTP:', sslErr.message);
    server = http.createServer(app);
    protocol = 'http';
  }
} else {
  server = http.createServer(app);
  protocol = 'http';
}

// Attach Socket.IO real-time hub
initializeSockets(server);

// Friendly port-in-use and network error handling (no raw stack trace)
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\nPort ${config.port} is already in use. Close the other EventSync window or run: set PORT=${config.port + 1} && npm start\n`);
    process.exit(1);
  }
  if (err.code === 'EACCES') {
    console.error(`\nPermission denied binding to ${config.host}:${config.port}. Try PORT=3000 or higher.\n`);
    process.exit(1);
  }
  console.error(`\n[Error] Server failed to start: ${err.message}\n`);
  process.exit(1);
});

// Bind server to configured host (default 0.0.0.0)
server.listen(config.port, config.host, async () => {
  const links = buildStartupLinks({
    protocol,
    port: config.port,
    serverHost: config.serverHost
  });

  let hasAdmin = true;
  try {
    const row = getDb()
      .prepare("SELECT 1 FROM users WHERE role = 'administrator' AND account_status = 'active' LIMIT 1")
      .get();
    hasAdmin = Boolean(row);
  } catch {
    hasAdmin = true;
  }

  const copied = copyToClipboard(links.localUrl);
  console.log('\n' + formatStartupBanner({ links, copied, hasAdmin }) + '\n');

  if (showQr) {
    const qrTarget = links.networkUrl || links.localUrl;
    try {
      const qrText = await QRCode.toString(qrTarget, { type: 'terminal', small: true });
      console.log(`   Scan QR to open ${qrTarget}:`);
      for (const line of qrText.trimEnd().split('\n')) {
        console.log('   ' + line);
      }
      console.log('');
    } catch {
      // Non-fatal if terminal doesn't support QR rendering
    }
  }

  if (showInfo) {
    console.log('   Quick Links:');
    console.log(`     Connect page:           ${links.connectUrl}`);
    console.log(`     Login:                  ${links.loginUrl}`);
    console.log(`     Sign up (participants): ${links.signupUrl}`);
    if (links.hotspotUrl && links.hotspotUrl !== links.networkUrl) {
      console.log(`     Hotspot network:        ${links.hotspotUrl}`);
    }
    if (links.interfaces.length > 0) {
      console.log('\n   Detected network interfaces:');
      for (const net of links.interfaces) {
        const marker = net.address === links.primaryIp ? ' (recommended)' : '';
        console.log(`     - [${net.interface}] ${net.label}: ${protocol}://${net.address}:${config.port}${marker}`);
      }
    }
    console.log('');
    if (protocol === 'http') {
      console.log('   Camera note: Phone camera QR scanning requires HTTPS (run "npm run start:https").');
    } else {
      console.log('   HTTPS active: Phones must trust the certificate (open /connect).');
    }
    if (process.platform === 'win32') {
      console.log('   Windows Firewall (if phones cannot connect, run in Admin CMD):');
      console.log(`     ${getFirewallHint(config.port)}`);
    }
    console.log('');
  }
});

// Handle graceful shutdown
function handleShutdown(signal) {
  console.log(`\n[Server] Received ${signal}. Shutting down gracefully...`);
  server.close(() => {
    console.log('[Server] Connections closed. Exiting.');
    process.exit(0);
  });
}

process.on('SIGINT', () => handleShutdown('SIGINT'));
process.on('SIGTERM', () => handleShutdown('SIGTERM'));
