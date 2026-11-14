#!/usr/bin/env node

/**
 * EventSync Distributed Systems: Network Diagnostic Tool
 * Run to verify LAN connectivity, HTTPS certificates, and mobile connection URLs.
 */

const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');
const fs = require('fs');

// Attempt to load .env from current directory or server directory
let targetServerUrl = process.argv[2] || process.env.SERVER_URL;

if (!targetServerUrl) {
  const envCandidates = [
    path.join(__dirname, '../server/.env'),
    path.join(__dirname, '../clients/registration/.env'),
    path.join(__dirname, '../clients/scanner/.env'),
    path.join(__dirname, '../clients/organizer/.env')
  ];

  for (const envPath of envCandidates) {
    if (fs.existsSync(envPath)) {
      const lines = fs.readFileSync(envPath, 'utf8').split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('SERVER_URL=')) {
          targetServerUrl = trimmed.split('=')[1].trim();
          break;
        }
      }
      if (targetServerUrl) break;
    }
  }
}

// Discover host's LAN IPs
const interfaces = os.networkInterfaces();
const lanIps = [];
for (const iface of Object.values(interfaces)) {
  for (const addr of iface) {
    if (addr.family === 'IPv4' && !addr.internal) {
      lanIps.push(addr.address);
    }
  }
}

const useHttps = process.env.HTTPS === 'true' && process.env.HTTP_ONLY !== 'true';
const defaultProto = useHttps ? 'https' : 'http';
targetServerUrl = targetServerUrl || (lanIps.length > 0 ? `${defaultProto}://${lanIps[0]}:3000` : `${defaultProto}://localhost:3000`);

console.log('\n================================================================');
console.log('   EVENTSYNC CLUSTER NETWORK DIAGNOSTIC TOOL                    ');
console.log('================================================================');
console.log(`[Target Server] Testing connection to: ${targetServerUrl}`);
if (lanIps.length > 0) {
  console.log(`[Local LAN IPs] Detected: ${lanIps.join(', ')}`);
}
console.log('');

const startTime = Date.now();

try {
  const parsedUrl = new URL(targetServerUrl);
  const isHttps = parsedUrl.protocol === 'https:';
  const clientLib = isHttps ? https : http;
  const healthPath = `${parsedUrl.pathname.replace(/\/$/, '')}/api/health`;

  const req = clientLib.get(
    {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: healthPath,
      rejectUnauthorized: false, // For testing local Root CA / SAN certs
      timeout: 5000
    },
    (res) => {
      let rawData = '';
      res.on('data', (chunk) => { rawData += chunk; });
      res.on('end', () => {
        const latency = Date.now() - startTime;
        if (res.statusCode === 200) {
          try {
            const json = JSON.parse(rawData);
            console.log('  [PASS] HTTP Status:       200 OK');
            console.log(`  [PASS] Protocol:          ${isHttps ? 'HTTPS (Encrypted LAN)' : 'HTTP'}`);
            console.log(`  [PASS] Network Latency:   ${latency} ms`);
            console.log(`  [PASS] Cluster Node ID:   ${json.data.nodeId} (${json.data.role})`);
            console.log(`  [PASS] Database State:    ${json.data.database}`);
            console.log(`  [PASS] Server Uptime:     ${json.data.uptimeSeconds} seconds`);
            console.log('\n================================================================');
            console.log('   STATUS: NODE 1 REACHABLE AND CLUSTER OPERATIONAL!            ');
            console.log('================================================================');
            console.log('\n📱 MOBILE & ANY-DEVICE ACCESS:');
            console.log(`   Open from any phone/tablet/laptop:`);
            console.log(`   ${isHttps ? 'https' : 'http'}://${parsedUrl.hostname}:${parsedUrl.port || 3000}/connect\n`);
            process.exit(0);
          } catch (e) {
            console.log('  [FAIL] Received invalid JSON response from server.');
            process.exit(1);
          }
        } else {
          console.log(`  [FAIL] Server returned HTTP error: ${res.statusCode}`);
          process.exit(1);
        }
      });
    }
  );

  req.on('timeout', () => {
    req.destroy();
    console.log('  [FAIL] Connection timed out after 5000ms.');
    printFirewallTroubleshooting(parsedUrl);
    process.exit(1);
  });

  req.on('error', (err) => {
    console.log(`  [FAIL] Network Error: ${err.message}`);
    printFirewallTroubleshooting(parsedUrl);
    process.exit(1);
  });
} catch (err) {
  console.log(`  [FAIL] Invalid URL format: ${err.message}`);
  process.exit(1);
}

function printFirewallTroubleshooting(url) {
  console.log('\n----------------------------------------------------------------');
  console.log('   TROUBLESHOOTING TIPS (LAN / Hotspot Setup):                  ');
  console.log('----------------------------------------------------------------');
  console.log('1. Verify that Laptop 1 (Server) is running: npm start');
  console.log('2. Check that devices are connected to the SAME Wi-Fi or Mobile Hotspot.');
  console.log('3. Windows Firewall Rule on Laptop 1 (Inbound Port 3000):');
  console.log('   Run in PowerShell as Administrator on Laptop 1:');
  console.log('   New-NetFirewallRule -DisplayName "EventSync Node 1" -Direction Inbound -LocalPort 3000 -Protocol TCP -Action Allow');
  console.log('4. Ensure client URL matches Laptop 1 LAN IP:');
  console.log(`   Currently pointing to: ${url.href}`);
  console.log('----------------------------------------------------------------\n');
}
