const http = require('http');
const https = require('https');
const QRCode = require('qrcode');
const app = require('./app');
const config = require('./config');
const { initializeDatabase } = require('./db/connection');
const { initializeSockets } = require('./sockets/socketManager');
const { buildStartupLinks, getFirewallHint } = require('./utils/network');
const { getOrGenerateCertificates } = require('./utils/cert');

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
    console.error(`\n[Error] Port ${config.port} is already in use.`);
    console.error(`  Fix 1 (use another port):  PORT=${config.port + 1} npm start`);
    console.error(`  Fix 2 (Windows find PID):  netstat -ano | findstr :${config.port}`);
    console.error(`                             taskkill /PID <PID> /F\n`);
    process.exit(1);
  }
  if (err.code === 'EACCES') {
    console.error(`\n[Error] Permission denied binding to ${config.host}:${config.port}. Try PORT=3000 or higher.\n`);
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

  console.log('\n================ EVENTSYNC IS RUNNING ================');
  console.log(`  Local (this laptop):    ${links.localUrl}`);
  console.log(`  On your network:        ${links.networkUrl}   <- open on phones/tablets/other laptops`);
  if (links.hotspotUrl && links.hotspotUrl !== links.networkUrl) {
    console.log(`  Hotspot network:        ${links.hotspotUrl}`);
  }
  console.log('');
  console.log(`  Connect page:           ${links.connectUrl}`);
  console.log(`  Login:                  ${links.loginUrl}`);
  console.log(`  Sign up (participants): ${links.signupUrl}`);

  if (links.interfaces.length > 0) {
    console.log('\n  Detected network interfaces:');
    for (const net of links.interfaces) {
      const marker = net.address === links.primaryIp ? ' (recommended)' : '';
      console.log(`    - [${net.interface}] ${net.label}: ${protocol}://${net.address}:${config.port}${marker}`);
    }
  }

  // Print terminal QR code for the network connect/login link
  try {
    const qrText = await QRCode.toString(links.connectUrl, { type: 'terminal', small: true });
    console.log('\n  Scan QR to open Connect page on phone:');
    for (const line of qrText.trimEnd().split('\n')) {
      console.log('  ' + line);
    }
  } catch {
    // Non-fatal if terminal doesn't support QR rendering
  }

  console.log('');
  if (protocol === 'http') {
    console.log('  Camera note: Phone camera QR scanning requires HTTPS (run "npm run start:https" or set HTTPS=true in .env).');
  } else {
    console.log('  HTTPS active: If phones warn about the local cert, open /connect to install the Root CA.');
  }
  if (process.platform === 'win32') {
    console.log(`  Windows Firewall (if phones cannot connect, run in Admin CMD):`);
    console.log(`    ${getFirewallHint(config.port)}`);
  }
  console.log('  Phones and laptops must be on the same Wi-Fi/hotspot.');
  console.log('  Stop the server with Ctrl+C.');
  console.log('======================================================\n');
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
