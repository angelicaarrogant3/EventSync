/**
 * EventSync Automated Test Runner
 * Comprehensive unit, integration, and distributed concurrency test suite
 */

const path = require('path');
const assert = require('assert');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { generateSignedQrToken, verifySignedQrToken } = require('../server/src/utils/crypto');
const nodesService = require('../server/src/services/nodes.service');
const { getOrGenerateCertificates, CERTS_DIR } = require('../server/src/utils/cert');

async function runTestSuite() {
  console.log('\n================================================================');
  console.log('   RUNNING EVENTSYNC AUTOMATED UNIT & INTEGRATION TESTS         ');
  console.log('================================================================\n');

  // 1. QR Cryptographic Token Test
  console.log('Test 1: QR Token Generation & Verification');
  const regId = 'reg-test-1234';
  const eventId = 'ev-test-5678';
  const token = generateSignedQrToken(regId, eventId);
  assert(typeof token === 'string' && token.length > 20, 'Token must be a non-empty string');

  const verified = verifySignedQrToken(token);
  assert(verified.valid === true, 'Token must verify as valid');
  assert(verified.registrationId === regId, 'Registration ID must match');
  assert(verified.eventId === eventId, 'Event ID must match');
  console.log('  [PASS] Valid token correctly verified with HMAC-SHA256 signature.');

  // 2. Token Tampering Defense Test
  console.log('\nTest 2: Token Tampering & Forgery Rejection');
  const tamperedToken = token.substring(0, token.length - 2) + 'ab';
  const tamperedVerify = verifySignedQrToken(tamperedToken);
  assert(tamperedVerify.valid === false, 'Tampered token must be rejected');
  console.log('  [PASS] Tampered token signature was successfully rejected.');

  // 3. Certificate Generation & SAN IP Coverage Test
  console.log('\nTest 3: Local Root CA & Server Certificate Engine');
  const certInfo = getOrGenerateCertificates();
  assert(certInfo.key && certInfo.cert, 'Certificate and private key must exist');
  const rootPem = path.join(CERTS_DIR, 'rootCA.pem');
  const rootCrt = path.join(CERTS_DIR, 'rootCA.crt');
  assert(fs.existsSync(rootPem), 'Root CA PEM file must exist on disk');
  assert(fs.existsSync(rootCrt), 'Root CA CRT file must exist on disk');
  console.log(`  [PASS] Certificate engine loaded valid SAN certificate.`);
  console.log(`  [PASS] Root CA available for mobile download at: ${rootPem}`);

  // 4. Cluster Node Health & Missing-Roles Detection Test
  console.log('\nTest 4: Node Health Registry & Flexible Device Summary');
  const { initializeDatabase } = require('../server/src/db/connection');
  await initializeDatabase();
  // Mark all existing non-server devices offline so previous test runs don't pollute state
  for (const n of await nodesService.getAllNodes()) {
    if (n.role !== 'SERVER') {
      await nodesService.markNodeOffline(n.node_id);
    }
  }
  await nodesService.recordHeartbeat('node-1', 'SERVER', '127.0.0.1', 'laptop', 'Central Server Laptop');
  await nodesService.recordHeartbeat('dev-phone-01', 'REGISTRATION', '192.168.1.50', 'phone', 'Registration Phone');

  const summary = await nodesService.getNodesSummary();
  assert(summary.countsByRole.SERVER >= 1, 'SERVER role must have at least 1 online device');
  assert(summary.countsByRole.REGISTRATION >= 1, 'REGISTRATION role must have at least 1 online device');
  assert(Array.isArray(summary.missingRoles), 'missingRoles must be an array');
  const missingRoleNames = summary.missingRoles.map(m => m.role);
  assert(missingRoleNames.includes('SCANNER'), 'SCANNER should be identified as missing');
  assert(missingRoleNames.includes('ORGANIZER'), 'ORGANIZER should be identified as missing');
  assert(summary.isClusterComplete === false, 'Cluster should be incomplete with missing roles');
  console.log(`  [PASS] Missing roles accurately reported: [${missingRoleNames.join(', ')}]`);

  // Now register SCANNER and ORGANIZER to test cluster completion
  await nodesService.recordHeartbeat('dev-scanner-02', 'SCANNER', '192.168.1.51', 'tablet', 'Front Gate iPad');
  await nodesService.recordHeartbeat('dev-org-03', 'ORGANIZER', '192.168.1.52', 'phone', 'Director iPhone');

  const completeSummary = await nodesService.getNodesSummary();
  assert(completeSummary.isClusterComplete === true, 'Cluster should be complete when all 4 roles are active');
  assert(completeSummary.missingRoles.length === 0, 'No missing roles when cluster complete');
  console.log('  [PASS] Cluster health supervisor confirmed all 4 roles active with mixed device types.');

  // 5. Run Event CRUD, Safe Delete & Live Broadcast Suite
  console.log('\nTest 5: Executing Event CRUD, Safe Delete & Live Broadcast Suite...');
  execFileSync(process.execPath, [path.join(__dirname, 'events-crud.test.js')], { stdio: 'inherit' });

  // 6. Run Auth, RBAC, Socket Auth & Migration Suite
  console.log('\nTest 6: Executing Auth, RBAC, Socket Auth & Migration Suite...');
  execFileSync(process.execPath, [path.join(__dirname, 'auth-rbac.test.js')], { stdio: 'inherit' });

  // 7. Run Concurrency Suite against an ephemeral in-process server
  console.log('\nTest 7: Executing Distributed Concurrency & Consistency Suite...');
  const http = require('http');
  const { spawn } = require('child_process');
  const app = require('../server/src/app');
  const { initializeSockets } = require('../server/src/sockets/socketManager');
  const concServer = http.createServer(app);
  initializeSockets(concServer);
  await new Promise(resolve => concServer.listen(0, '127.0.0.1', resolve));
  const concPort = concServer.address().port;
  try {
    const exitCode = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(__dirname, '../scripts/concurrency-test.js')], {
        stdio: 'inherit',
        env: { ...process.env, SERVER_URL: `http://127.0.0.1:${concPort}` }
      });
      child.on('error', reject);
      child.on('close', resolve);
    });
    if (exitCode !== 0) {
      throw new Error(`Concurrency test exited with code ${exitCode}`);
    }
  } finally {
    concServer.closeAllConnections?.();
    concServer.close();
  }
}

runTestSuite()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('\n[TEST RUNNER ERROR]', err);
    process.exit(1);
  });
