#!/usr/bin/env node

/**
 * EventSync: Distributed Systems Concurrency & Consistency Test
 * Verifies ACID invariants:
 * 1. Zero Overbooking (Atomic capacity check under concurrent registrations)
 * 2. Race-Safe Double Check-In Guard (Single attendance entry per participant)
 * 3. Idempotent Offline Sync (Duplicate scan replay rejection)
 */

const http = require('http');
const https = require('https');

const SERVER_URL = process.env.SERVER_URL || (process.env.HTTPS === 'true' ? 'https://localhost:3000' : 'http://localhost:3000');
const parsedUrl = new URL(SERVER_URL);
const isHttps = parsedUrl.protocol === 'https:';
const clientLib = isHttps ? https : http;
let authCookie = '';

function makeRequest(method, urlPath, body = null) {
  return new Promise((resolve, reject) => {
    const postData = body ? JSON.stringify(body) : null;
    const req = clientLib.request(
      {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (isHttps ? 443 : 80),
        path: urlPath,
        method,
        rejectUnauthorized: false,
        headers: {
          'Content-Type': 'application/json',
          'x-node-id': 'concurrency-tester',
          ...(authCookie ? { Cookie: authCookie } : {}),
          ...(postData ? { 'Content-Length': Buffer.byteLength(postData) } : {})
        }
      },
      (res) => {
        let raw = '';
        res.on('data', chunk => { raw += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(raw);
            resolve({ status: res.statusCode, data: parsed });
          } catch {
            resolve({ status: res.statusCode, raw });
          }
        });
      }
    );

    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

async function ensureAuthCookie() {
  if (process.env.ADMIN_USERNAME && process.env.ADMIN_PASSWORD) {
    const res = await new Promise((resolve, reject) => {
      const payload = JSON.stringify({
        usernameOrEmail: process.env.ADMIN_USERNAME,
        password: process.env.ADMIN_PASSWORD
      });
      const req = clientLib.request({
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (isHttps ? 443 : 80),
        path: '/api/auth/login',
        method: 'POST',
        rejectUnauthorized: false,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
      }, r => {
        const sc = r.headers['set-cookie'];
        r.resume();
        r.on('end', () => resolve(Array.isArray(sc) && sc[0] ? sc[0].split(';')[0] : ''));
      });
      req.on('error', reject);
      req.write(payload);
      req.end();
    });
    if (res) { authCookie = res; return; }
  }
  // Fallback: create a temporary admin session directly in local SQLite DB
  const { initializeDatabase } = require('../server/src/db/connection');
  const { createAdministrator, createSession } = require('../server/src/services/auth.service');
  initializeDatabase();
  const uname = `conc_admin_${Date.now()}`;
  const admin = createAdministrator({ full_name: 'Concurrency Admin', username: uname, email: `${uname}@eventsync.test`, password: 'TestPassword123!' });
  const { sessionId } = createSession(admin.id);
  authCookie = `eventsync_sid=${sessionId}`;
}

async function runTests() {
  console.log('\n================================================================');
  console.log('   EVENTSYNC: DISTRIBUTED CONCURRENCY & CONSISTENCY TEST SUITE  ');
  console.log('================================================================');
  console.log(`Target Node 1 API: ${SERVER_URL}\n`);

  await ensureAuthCookie();

  let allPassed = true;

  // --------------------------------------------------------------------------
  // TEST 1: Capacity Limit Enforcement Under Concurrent Blast
  // --------------------------------------------------------------------------
  console.log('--- TEST 1: Atomic Capacity Guard (Simultaneous Last-Slot Blast) ---');
  console.log('Creating a test event with capacity = 3...');

  const eventRes = await makeRequest('POST', '/api/events', {
    title: 'Distributed Concurrency Stress Test Event',
    venue: 'Lab 402',
    event_date: '2026-11-30',
    start_time: '10:00',
    end_time: '12:00',
    capacity: 3,
    status: 'OPEN'
  });

  const testEventId = eventRes.data.data.id;
  console.log(`Event created (ID: ${testEventId}, Capacity: 3)`);
  console.log('Firing 10 simultaneous registration requests...');

  const regPromises = [];
  for (let i = 1; i <= 10; i++) {
    const p = makeRequest('POST', '/api/registrations', {
      eventId: testEventId,
      participant: {
        school_id: `STRESS-REG-${Date.now()}-${i}`,
        full_name: `Concurrent Participant ${i}`,
        email: `stress${i}@university.edu`,
        department_or_course: 'BS Computer Science',
        year_level: '4th Year',
        role: 'STUDENT'
      }
    });
    regPromises.push(p);
  }

  const regResults = await Promise.all(regPromises);

  const successRegs = regResults.filter(r => r.status === 201);
  const fullRejections = regResults.filter(r => r.status === 409 && r.data.error && r.data.error.code === 'EVENT_FULL');

  console.log(`Results: ${successRegs.length} Accepted (201), ${fullRejections.length} Rejected (409 EVENT_FULL)`);

  // Verify final count in DB
  const finalEventCheck = await makeRequest('GET', `/api/events/${testEventId}`);
  const finalRegCount = finalEventCheck.data.data.registered_count;
  console.log(`Final Database Registrations: ${finalRegCount} / 3`);

  if (successRegs.length === 3 && fullRejections.length === 7 && finalRegCount === 3) {
    console.log('  [PASS] ZERO OVERBOOKING: Exactly 3 slots filled, remaining 7 rejected.');
  } else {
    console.log('  [FAIL] Overbooking occurred or invalid responses.');
    allPassed = false;
  }

  // --------------------------------------------------------------------------
  // TEST 2: Concurrent Duplicate Check-In Race Guard
  // --------------------------------------------------------------------------
  console.log('\n--- TEST 2: Race-Safe Double Check-In Guard ---');
  // Take one of the successfully registered participants
  const validRegistration = successRegs[0].data.data;
  const qrToken = validRegistration.registration.qrToken;
  console.log(`Using valid registered QR Token for participant: ${validRegistration.participant.full_name}`);
  console.log('Firing 8 simultaneous check-in attempts for the SAME registration...');

  const checkInPromises = [];
  for (let i = 1; i <= 8; i++) {
    const p = makeRequest('POST', '/api/attendance/scan', {
      eventId: testEventId,
      qrToken,
      clientScanId: `concurrent-scan-${Date.now()}-${i}`,
      scannedAt: new Date().toISOString()
    });
    checkInPromises.push(p);
  }

  const checkInResults = await Promise.all(checkInPromises);

  const validCheckIns = checkInResults.filter(r => r.status === 200 && r.data.data && r.data.data.status === 'VALID');
  const duplicateCheckIns = checkInResults.filter(r => r.status === 409 && r.data.error && r.data.error.code === 'ALREADY_CHECKED_IN');

  console.log(`Results: ${validCheckIns.length} Verified (200 VALID), ${duplicateCheckIns.length} Rejected (409 ALREADY_CHECKED_IN)`);

  if (validCheckIns.length === 1 && duplicateCheckIns.length === 7) {
    console.log('  [PASS] SINGLE ATTENDANCE INVARIANT: Exactly 1 recorded, 7 duplicate attempts rejected.');
  } else {
    console.log('  [FAIL] Duplicate attendance records created.');
    allPassed = false;
  }

  // --------------------------------------------------------------------------
  // TEST 3: Idempotent Batch Sync Replay
  // --------------------------------------------------------------------------
  console.log('\n--- TEST 3: Idempotent Offline Sync Batch Replay ---');
  // Register another participant to check in via offline sync
  const regForSync = await makeRequest('POST', '/api/registrations', {
    eventId: testEventId,
    participant: {
      school_id: `OFFLINE-SYNC-${Date.now()}`,
      full_name: 'Offline Queued Student',
      email: 'offline.student@university.edu',
      department_or_course: 'BS Information Technology',
      year_level: '3rd Year',
      role: 'STUDENT'
    }
  });

  // Note: testEventId capacity is 3 and already full. Let's create an open event for sync testing.
  const syncEventRes = await makeRequest('POST', '/api/events', {
    title: 'Offline Sync Batch Test Event',
    venue: 'Seminar Room B',
    event_date: '2026-11-28',
    start_time: '14:00',
    end_time: '16:00',
    capacity: 10,
    status: 'OPEN'
  });
  const syncEventId = syncEventRes.data.data.id;

  const syncRegRes = await makeRequest('POST', '/api/registrations', {
    eventId: syncEventId,
    participant: {
      school_id: `OFFLINE-SYNC-STU-${Date.now()}`,
      full_name: 'Offline Student 1',
      email: 'offline1@university.edu',
      department_or_course: 'BS IT',
      year_level: '2nd Year',
      role: 'STUDENT'
    }
  });

  const syncQrToken = syncRegRes.data.data.registration.qrToken;
  const staticScanId = `fixed-client-scan-id-${Date.now()}`;

  const offlineBatch = [
    {
      eventId: syncEventId,
      qrToken: syncQrToken,
      clientScanId: staticScanId,
      scannedAt: '2026-11-28 14:05:00'
    }
  ];

  console.log('Submitting offline sync batch (Attempt 1)...');
  const sync1 = await makeRequest('POST', '/api/attendance/sync', offlineBatch);
  console.log(`Sync 1 Result: ${sync1.data.data.syncedCount} scan(s) synced.`);

  console.log('Replaying EXACT same offline sync batch (Attempt 2 - Network duplicate simulation)...');
  const sync2 = await makeRequest('POST', '/api/attendance/sync', offlineBatch);
  console.log(`Sync 2 Result: isIdempotentReplay = ${sync2.data.data.results[0].isIdempotentReplay}`);

  // Check attendance records count in DB
  const liveAttendance = await makeRequest('GET', `/api/events/${syncEventId}/attendance/live`);
  const totalAttendanceRecorded = liveAttendance.data.data.checkedInCount;

  if (sync1.data.data.syncedCount === 1 && totalAttendanceRecorded === 1 && sync2.data.data.results[0].isIdempotentReplay === true) {
    console.log('  [PASS] IDEMPOTENCY INVARIANT: Replaying offline queue does not create duplicates.');
  } else {
    console.log('  [FAIL] Idempotency violated.');
    allPassed = false;
  }

  // --------------------------------------------------------------------------
  // Summary
  // --------------------------------------------------------------------------
  console.log('\n================================================================');
  if (allPassed) {
    console.log('   ALL DISTRIBUTED CONCURRENCY & CONSISTENCY TESTS PASSED!      ');
  } else {
    console.log('   SOME TESTS FAILED! CHECK LOGS ABOVE.                         ');
  }
  console.log('================================================================\n');

  process.exit(allPassed ? 0 : 1);
}

runTests().catch(err => {
  console.error('Unhandled test runner exception:', err);
  process.exit(1);
});

