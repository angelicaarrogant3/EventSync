const http = require('http');
const fs = require('fs');
const path = require('path');

// Simple .env parser to avoid external dependencies on client node
function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const [key, ...vals] = trimmed.split('=');
      if (key && vals.length > 0) {
        process.env[key.trim()] = vals.join('=').trim();
      }
    }
  }
}
loadEnv();

const PORT = parseInt(process.env.PORT || '3003', 10);
const NODE_ID = process.env.NODE_ID || 'node-4';
const NODE_ROLE = process.env.NODE_ROLE || 'ORGANIZER';
const SERVER_URL = process.env.SERVER_URL || 'http://localhost:3000';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

const publicDir = path.join(__dirname, 'public');

const server = http.createServer((req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
  const pathname = parsedUrl.pathname;

  // Configuration endpoint for client front-end
  if (pathname === '/config') {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    });
    return res.end(JSON.stringify({
      serverUrl: process.env.SERVER_URL || SERVER_URL,
      nodeId: NODE_ID,
      role: NODE_ROLE,
      port: PORT
    }));
  }

  // Resolve static files
  let safePath = path.normalize(pathname).replace(/^(\.\.[\/\\])+/, '');
  if (safePath === '/' || safePath === '\\') {
    safePath = '/index.html';
  }

  let filePath = path.join(publicDir, safePath);

  // If not in client public dir, fallback to shared vendor directory if requested
  if (!fs.existsSync(filePath) && safePath.startsWith('/vendor/')) {
    const sharedVendorPath = path.join(__dirname, '../shared/vendor', safePath.replace('/vendor/', ''));
    if (fs.existsSync(sharedVendorPath)) {
      filePath = sharedVendorPath;
    }
  }

  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    fs.createReadStream(filePath).pipe(res);
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('404 Not Found');
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('\n================================================================');
  console.log('   EVENTSYNC - NODE 4: ORGANIZER CONSOLE & LIVE MONITOR         ');
  console.log('================================================================');
  console.log(`[Status] Local Console UI: http://localhost:${PORT}`);
  console.log(`[Config] Target Node 1:   ${SERVER_URL}`);
  console.log(`[Config] Role:            ${NODE_ROLE} (${NODE_ID})`);
  console.log('================================================================\n');
});

